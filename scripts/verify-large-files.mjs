// 大文件阅读 + 连点压力实测：用 headless Edge 走 CDP 驱动真实界面。
//
// 用法：先起 vite（127.0.0.1:5273），再 `node scripts/verify-large-files.mjs`。
// 产物：`.tmp/verify-*.png` 截图 + 终端里的 JSON 结论。

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9333
const APP_URL = 'http://127.0.0.1:5273/'
const OUT_DIR = path.resolve('.tmp')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitOk(url, timeoutMs = 40_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
    } catch {
      // 还没起来
    }
    await sleep(200)
  }
  throw new Error(`等待 ${url} 超时`)
}

async function waitJson(url, timeoutMs = 20_000) {
  return (await waitOk(url, timeoutMs)).json()
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.events = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const slot = this.pending.get(message.id)
        if (!slot) return
        this.pending.delete(message.id)
        if (message.error) slot.reject(new Error(JSON.stringify(message.error)))
        else slot.resolve(message.result)
        return
      }
      const handlers = this.events.get(message.method) || []
      for (const handler of handlers) handler(message.params)
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    return new Cdp(ws)
  }

  send(method, params = {}) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  once(method, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const list = this.events.get(method) || []
      const timer = setTimeout(() => reject(new Error(`等待事件 ${method} 超时`)), timeoutMs)
      const handler = (params) => {
        clearTimeout(timer)
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
        resolve(params)
      }
      list.push(handler)
      this.events.set(method, list)
    })
  }

  async eval(expression, timeoutMs = 30_000) {
    const result = await Promise.race([
      this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: timeoutMs,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('eval 超时')), timeoutMs + 2000)),
    ])
    if (result.exceptionDetails) {
      throw new Error(`页面异常：${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`)
    }
    return result.result.value
  }

  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(OUT_DIR, `verify-${name}.png`)
    writeFileSync(file, Buffer.from(result.data, 'base64'))
    return file
  }
}

// 页面内工具函数：按文件名点树行、等待编辑器就绪、读当前视图状态。
const PAGE_HELPERS = `
window.__ocw = {
  row(name) {
    return [...document.querySelectorAll('.tree-row')].find(
      (row) => row.querySelector('.tree-name')?.textContent === name,
    )
  },
  clickRow(name) {
    const row = this.row(name)
    if (!row) return false
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  },
  async clickReady(name, timeout = 10000) {
    const started = performance.now()
    while (performance.now() - started < timeout) {
      const row = this.row(name)
      if (row) {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return false
  },
  async waitPath(name, timeout = 15000) {
    const started = performance.now()
    while (performance.now() - started < timeout) {
      const shown = document.querySelector('.editor-path-text')?.textContent || ''
      if (shown.split(/[\\\\/]/).pop() === name) return true
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return false
  },
  async open(name, timeout = 15000) {
    const started = performance.now()
    if (!(await this.clickReady(name))) return { ok: false, reason: 'row-not-found' }
    const ok = await this.waitPath(name, timeout)
    return { ok, elapsed: Math.round(performance.now() - started) }
  },
  state() {
    const rows = [...document.querySelectorAll('.code-line')]
    const first = rows[0]
    const last = rows[rows.length - 1]
    return {
      path: document.querySelector('.editor-path-text')?.textContent || '',
      toolbar: document.querySelector('.editor-toolbar')?.textContent?.replace(/\\s+/g, ' ').trim() || '',
      lineRows: rows.length,
      firstNo: first?.querySelector('.line-no')?.textContent ?? null,
      firstText: first?.querySelector('.code-text')?.textContent ?? null,
      lastNo: last?.querySelector('.line-no')?.textContent ?? null,
      lastText: last?.querySelector('.code-text')?.textContent ?? null,
      scrollHeight: document.querySelector('.code-scroll')?.scrollHeight ?? 0,
      treeRows: document.querySelectorAll('.tree-row').length,
      domNodes: document.querySelectorAll('*').length,
      note: document.querySelector('.editor-note')?.textContent ?? null,
      hex: document.querySelector('.hex-dump')?.textContent?.slice(0, 80) ?? null,
      image: document.querySelector('.editor-image img')?.src?.startsWith('blob:') ?? false,
      imageWidth: document.querySelector('.editor-image img')?.naturalWidth ?? 0,
      pendingRows: document.querySelectorAll('.code-text.pending').length,
      flashRows: document.querySelectorAll('.code-line.flash').length,
      currentLine: document.querySelector('.editor-current-line')?.textContent ?? null,
    }
  },
  scrollBottom() {
    const el = document.querySelector('.code-scroll')
    if (!el) return false
    el.scrollTop = el.scrollHeight
    return true
  },
  clickMode(label) {
    const button = [...document.querySelectorAll('.editor-modes button')].find(
      (item) => item.textContent === label,
    )
    if (!button) return false
    button.click()
    return true
  },
  async stress(names, rounds) {
    let running = true
    let last = performance.now()
    let maxGap = 0
    let frames = 0
    const tick = () => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
      frames += 1
      if (running) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    const started = performance.now()
    for (let i = 0; i < rounds; i += 1) {
      this.clickRow(names[i % names.length])
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const clicked = performance.now() - started
    await new Promise((resolve) => setTimeout(resolve, 600))
    running = false
    return {
      clicked: Math.round(clicked),
      frames,
      maxGap: Math.round(maxGap),
      finalPath: document.querySelector('.editor-path-text')?.textContent || '',
      lineRows: document.querySelectorAll('.code-line').length,
    }
  },
};
true
`

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  await waitOk(APP_URL).catch(() => {
    throw new Error('vite 没起来：先在 127.0.0.1:5273 起 dev server')
  })

  const userDataDir = path.join(process.env.TEMP || OUT_DIR, 'ocwb-edge-profile')
  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--disable-gpu',
      '--window-size=1500,950',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    const version = await waitJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 20_000)
    console.log('browser:', version['Browser'])
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
    const page = targets.find((item) => item.type === 'page')
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    cdp.events.set('Runtime.exceptionThrown', [])
    cdp.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        const detail = message.params.exceptionDetails
        console.log('[page-exception]', detail.text, (detail.exception?.description ?? '').slice(0, 200))
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        console.log('[page-error]', message.params.args.map((arg) => arg.value ?? arg.description).join(' ').slice(0, 300))
      }
    })
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1500,
      height: 950,
      deviceScaleFactor: 1,
      mobile: false,
    })

    const loaded = cdp.once('Page.loadEventFired')
    await cdp.send('Page.navigate', { url: APP_URL })
    await loaded
    await cdp.eval(PAGE_HELPERS)

    // 等文件树首屏
    // StrictMode 下 FileTree 会先挂载再卸载重挂，等行数连续两次一致才算稳定。
    const treeReady = await cdp.eval(`new Promise((resolve) => {
      const started = performance.now()
      let last = -1
      let stable = 0
      const tick = () => {
        const count = document.querySelectorAll('.tree-row').length
        if (count > 0 && count === last) stable += 1
        else stable = 0
        last = count
        if (stable >= 3) return resolve(true)
        if (performance.now() - started > 15000) return resolve(false)
        setTimeout(tick, 100)
      }
      tick()
    })`)
    if (!treeReady) {
      const diag = await cdp.eval(`({
        readyState: document.readyState,
        text: document.body.innerText.slice(0, 600),
        scripts: [...document.scripts].map((item) => item.src),
        hasApp: !!document.querySelector('.app'),
        paneNotice: document.querySelector('.pane-notice')?.textContent ?? null,
      })`)
      console.log('diagnostics:', JSON.stringify(diag, null, 2))
      throw new Error('文件树没有渲染出来')
    }

    const result = { browser: version['Browser'], checks: {} }

    // 1. 展开 .tmp
    const openedTmp = await cdp.eval(`window.__ocw.clickReady('.tmp')`)
    const tmpExpanded = await cdp.eval(`new Promise((resolve) => {
      const started = performance.now()
      const tick = () => {
        if (window.__ocw.row('big-5mb.log')) return resolve(true)
        if (performance.now() - started > 8000) return resolve(false)
        setTimeout(tick, 50)
      }
      tick()
    })`)
    if (!openedTmp || !tmpExpanded) {
      console.log('tree rows:', await cdp.eval(`[...document.querySelectorAll('.tree-row')].map((r) => r.textContent)`))
      throw new Error(`展开 .tmp 失败（click=${openedTmp} expanded=${tmpExpanded}）`)
    }
    await cdp.eval(`new Promise((resolve) => {
      const started = performance.now()
      const tick = () => {
        if (window.__ocw.row('big-5mb.log')) return resolve(true)
        if (performance.now() - started > 8000) return resolve(false)
        requestAnimationFrame(tick)
      }
      tick()
    })`)

    // 2. 5MB / 15 万行：打开 + 首屏 + 滚到底
    const open5 = await cdp.eval(`window.__ocw.open('big-5mb.log')`)
    await sleep(300)
    const top5 = await cdp.eval('window.__ocw.state()')
    result.checks.open5mb = { ...open5, ...top5 }
    await cdp.shot('big-5mb-top')
    await cdp.eval('window.__ocw.scrollBottom()')
    await sleep(700)
    result.checks.bottom5mb = await cdp.eval('window.__ocw.state()')
    await cdp.shot('big-5mb-bottom')

    // 3. 30MB / 60 万行
    const open30 = await cdp.eval(`window.__ocw.open('huge-30mb.log')`)
    await sleep(400)
    result.checks.open30mb = { ...open30, ...(await cdp.eval('window.__ocw.state()')) }
    await cdp.eval('window.__ocw.scrollBottom()')
    await sleep(800)
    result.checks.bottom30mb = await cdp.eval('window.__ocw.state()')
    await cdp.shot('huge-30mb-bottom')

    // 3.5 跳转到第 30 万行：输入框 + 按钮，目标行应出现在视口顶部并短暂高亮
    const inputReady = await cdp.eval(`(() => {
      const input = document.querySelector('.editor-jump-input')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '300000')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(150)
    const jumpClicked = await cdp.eval(`(() => {
      const button = document.querySelector('.editor-jump-btn')
      if (!button) return false
      button.click()
      return true
    })()`)
    await sleep(500)
    result.checks.jump = { inputReady, clicked: jumpClicked, ...(await cdp.eval('window.__ocw.state()')) }
    const ctrlG = await cdp.eval(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }))
      return document.activeElement?.className?.toString().includes('editor-jump-input') ?? false
    })()`)
    result.checks.jumpFocus = ctrlG
    await cdp.shot('jump-line')

    // 3.6 Ctrl+F 整文件搜索：输入末行标记 → 命中计数 / 高亮 / 跳转
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))`)
    await sleep(200)
    const searchReady = await cdp.eval(`(() => {
      const input = document.querySelector('.editor-search-input')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'end-599999')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(1200)
    result.checks.search = {
      searchReady,
      ...(await cdp.eval(`({
        count: document.querySelector('.editor-search-count')?.textContent ?? null,
        marks: document.querySelectorAll('.code-text mark').length,
        matchRows: document.querySelectorAll('.code-line.match').length,
        currentLine: document.querySelector('.editor-current-line')?.textContent ?? null,
      })`)),
    }
    await cdp.shot('search')
    await cdp.eval(`document.querySelector('.editor-search-close')?.click()`)
    await sleep(200)

    // 4. 1.1MB Markdown：预览降级 + 源码分页
    const openMd = await cdp.eval(`window.__ocw.open('long.md')`)
    await sleep(400)
    const previewState = await cdp.eval('window.__ocw.state()')
    await cdp.eval(`window.__ocw.clickMode('源码')`)
    await sleep(500)
    const mdSource = await cdp.eval('window.__ocw.state()')
    result.checks.markdown = { ...openMd, preview: previewState, source: mdSource }
    await cdp.shot('markdown-source')

    // 5. 二进制 + 图片
    const openBin = await cdp.eval(`window.__ocw.open('sample.bin')`)
    await sleep(400)
    result.checks.binary = { ...openBin, ...(await cdp.eval('window.__ocw.state()')) }
    await cdp.shot('binary-hex')
    const openPng = await cdp.eval(`window.__ocw.open('test.png')`)
    await sleep(500)
    result.checks.image = { ...openPng, ...(await cdp.eval('window.__ocw.state()')) }
    await cdp.shot('image')

    // 5.5 超长行（30 行 × 40KB，单窗口 512KB 会提前截断）：缺口必须能续拉，不能留 pending
    const openWide = await cdp.eval(`window.__ocw.open('wide-lines.log')`)
    await sleep(700)
    const wideTop = await cdp.eval('window.__ocw.state()')
    await cdp.eval('window.__ocw.scrollBottom()')
    await sleep(700)
    const wideBottom = await cdp.eval('window.__ocw.state()')
    result.checks.wideLines = { open: openWide, top: wideTop, bottom: wideBottom }
    await cdp.shot('wide-lines')

    // 6. 连续点击压力：5 个文件来回 40 次，记录最长掉帧
    result.checks.stress = await cdp.eval(
      `window.__ocw.stress(['big-5mb.log','huge-30mb.log','long.md','sample.bin','test.png'], 40)`,
    )
    await cdp.shot('after-stress')

    // 7. 文件树虚拟化：把顶层目录都展开，看 DOM 行数
    const dirs = ['demo', 'docs', 'hashline-plugin', 'shell', 'specs', 'src']
    for (const dir of dirs) {
      await cdp.eval(`window.__ocw.clickRow(${JSON.stringify(dir)})`)
      await sleep(120)
    }
    result.checks.tree = await cdp.eval(`(() => ({
      treeRows: document.querySelectorAll('.tree-row').length,
      domNodes: document.querySelectorAll('*').length,
      scrollHeight: document.querySelector('.tree-scroll')?.scrollHeight ?? 0,
    }))()`)
    await cdp.shot('tree-expanded')

    console.log(JSON.stringify(result, null, 2))
    writeFileSync(path.join(OUT_DIR, 'verify-result.json'), JSON.stringify(result, null, 2))
  } finally {
    edge.kill()
  }
}

main().catch((err) => {
  console.error('验证失败：', err.message)
  process.exit(1)
})
