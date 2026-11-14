// 多文件标签验收：同时打开多个文件、切换、各标签状态是否独立、关闭行为。
//
// 用法：
//   1) dev：先起 vite（127.0.0.1:5273），再 `node scripts/verify-file-tabs.mjs`
//   2) exe：带 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9231 启动 exe，
//      再 `$env:OCW_CDP_PORT=9231; node scripts/verify-file-tabs.mjs`
// 产物：`.tmp/verify-file-tabs.json` + 截图。

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9335
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
      throw new Error(
        `页面异常：${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`,
      )
    }
    return result.result.value
  }

  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(OUT_DIR, `verify-tabs-${name}.png`)
    writeFileSync(file, Buffer.from(result.data, 'base64'))
    return file
  }
}

const PAGE_HELPERS = `
window.__oct = {
  row(name) {
    return [...document.querySelectorAll('.tree-row')].find(
      (row) => row.querySelector('.tree-name')?.textContent === name,
    )
  },
  async findAndClick(name, timeout = 10000) {
    const started = performance.now()
    const scroll = document.querySelector('.tree-scroll')
    let offset = scroll ? scroll.scrollTop : 0
    let direction = 1
    while (performance.now() - started < timeout) {
      const row = this.row(name)
      if (row) {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return true
      }
      if (!scroll) return false
      const step = Math.max(160, scroll.clientHeight * 0.9)
      const maxTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
      offset += step * direction
      if (offset > maxTop) { offset = maxTop; direction = -1 }
      else if (offset < 0) { offset = 0; direction = 1 }
      scroll.scrollTop = offset
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    return false
  },
  async open(name, timeout = 20000) {
    const started = performance.now()
    if (!(await this.findAndClick(name))) return { ok: false, reason: 'row-not-found' }
    const ok = await this.waitActive(name, timeout)
    await new Promise((resolve) => setTimeout(resolve, 350))
    return { ok, elapsed: Math.round(performance.now() - started) }
  },
  /** 树的总行数：.tree-rows 的高度 = rows.length × 24（ROW_HEIGHT），不受虚拟化影响。 */
  totalRows() {
    const box = document.querySelector('.tree-rows')
    if (!box) return 0
    const height = parseFloat(box.style.height || '0')
    return Math.round(height / 24)
  },
  async waitActive(name, timeout = 15000) {
    const started = performance.now()
    while (performance.now() - started < timeout) {
      const label = document.querySelector('.file-tab.active .file-tab-name')?.textContent || ''
      if (label === name) return true
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    return false
  },
  tabs() {
    return [...document.querySelectorAll('.file-tab')].map((tab) => ({
      name: tab.querySelector('.file-tab-name')?.textContent ?? '',
      active: tab.classList.contains('active'),
      dirty: !!tab.querySelector('.file-tab-dirty'),
    }))
  },
  state() {
    return {
      tabs: this.tabs(),
      path: document.querySelector('.editor-slot:not([style*="display: none"]) .editor-path-text')?.textContent ?? null,
      lines: document.querySelectorAll('.editor-slot:not([style*="display: none"]) .code-line').length,
      scrollTop: document.querySelector('.editor-slot:not([style*="display: none"]) .code-scroll')?.scrollTop ?? 0,
      editing: !!document.querySelector('.editor-slot:not([style*="display: none"]) .code-edit-area'),
      draft: document.querySelector('.editor-slot:not([style*="display: none"]) .code-edit-area')?.value ?? null,
      empty: document.querySelector('.editor-slot:not([style*="display: none"]) .editor-empty')?.innerText ?? null,
    }
  },
  clickTab(name) {
    const tab = [...document.querySelectorAll('.file-tab')].find(
      (item) => item.querySelector('.file-tab-name')?.textContent === name,
    )
    if (!tab) return false
    tab.click()
    return true
  },
  closeTab(name) {
    const tab = [...document.querySelectorAll('.file-tab')].find(
      (item) => item.querySelector('.file-tab-name')?.textContent === name,
    )
    if (!tab) return false
    tab.querySelector('.file-tab-close')?.click()
    return true
  },
  clickCloseAll() {
    const button = document.querySelector('.file-tabs-close-all')
    if (!button) return false
    button.click()
    return true
  },
  scrollActive(top) {
    const el = document.querySelector('.editor-slot:not([style*="display: none"]) .code-scroll')
    if (!el) return false
    el.scrollTop = top
    return true
  },
};
true
`

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const exePort = process.env.OCW_CDP_PORT ? Number(process.env.OCW_CDP_PORT) : null
  if (!exePort) await waitOk(APP_URL)

  const port = exePort ?? DEBUG_PORT
  const userDataDir = path.join(process.env.TEMP || OUT_DIR, 'ocwb-edge-profile-tabs')
  let cdp = null
  const edge = exePort
    ? null
    : spawn(
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
    await waitOk(`http://127.0.0.1:${port}/json/version`, 20_000)
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = targets.find((item) => item.type === 'page')
    cdp = await Cdp.connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    cdp.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') {
        const detail = message.params.exceptionDetails
        console.log('[page-exception]', detail.text, (detail.exception?.description ?? '').slice(0, 200))
      }
    })
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1500,
      height: 950,
      deviceScaleFactor: 1,
      mobile: false,
    })

    if (exePort) {
      await cdp.eval(PAGE_HELPERS)
    } else {
      const loaded = cdp.once('Page.loadEventFired')
      await cdp.send('Page.navigate', { url: APP_URL })
      await loaded
      const reloaded = cdp.once('Page.loadEventFired')
      await cdp.eval(
        `window.localStorage.setItem('oc-workbench:root', ${JSON.stringify(path.resolve('.'))})`,
      )
      await cdp.send('Page.reload')
      await reloaded
      await cdp.eval(PAGE_HELPERS)
    }

    // 文件树首屏稳定 + 展开 .tmp/formats
    await cdp.eval(`new Promise((resolve) => {
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
    await cdp.eval(`document.querySelector('.tree-scroll') && (document.querySelector('.tree-scroll').scrollTop = 0)`)
    await sleep(300)
    // 用「总行数有没有变多」判断目录是否展开：
    // 子行看不见可能只是滚出了虚拟列表视口，不能当成没展开（否则会把它点成折叠）。
    // 用「总行数」判断目录展开状态：子行看不见可能只是滚出了虚拟列表视口。
    // 点一下会切换折叠状态，所以三种情况都要处理：变了多=展开了、变了少=刚被折叠、没变=不是目录。
    const ensureDir = (dirName) => `(async () => {
      const before = window.__oct.totalRows()
      if (!(await window.__oct.findAndClick(${JSON.stringify(dirName)}))) return false
      await new Promise((r) => setTimeout(r, 600))
      const after = window.__oct.totalRows()
      if (after > before) return true
      if (after === before) return false
      // 行数变少 = 本来就展开着，这一下把它折叠了：再点回来，恢复成展开
      if (!(await window.__oct.findAndClick(${JSON.stringify(dirName)}))) return false
      await new Promise((r) => setTimeout(r, 600))
      return window.__oct.totalRows() >= before
    })()`
    const tmpOk = await cdp.eval(ensureDir('.tmp'))
    const formatsOk = await cdp.eval(ensureDir('formats'))
    if (!tmpOk || !formatsOk) throw new Error(`展开 .tmp/formats 失败（${tmpOk}/${formatsOk}）`)
    await sleep(400)

    // 关闭按钮的确认框：headless 里默认会被自动关掉，统一当成「确定」
    await cdp.eval(`window.confirm = () => true; true`)

    const result = { checks: {} }

    // 0. 清掉上一次运行留下的标签，避免顺序断言被上一轮影响。
    //    只有一个标签时没有「全部关闭」按钮，所以逐个点 × 关。
    result.checks.tabsBeforeStart = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      for (let i = 0; i < 20; i += 1) {
        const close = document.querySelector('.file-tab .file-tab-close')
        if (!close) break
        close.click()
        await sleep(150)
      }
      return document.querySelectorAll('.file-tab').length
    })()`)

    // 1. 依次打开 3 个文件：标签应累加，不是互相顶掉
    const openA = await cdp.eval(`window.__oct.open('index.html')`)
    const openB = await cdp.eval(`window.__oct.open('data.json')`)
    const openC = await cdp.eval(`window.__oct.open('code.py')`)
    result.checks.openThree = {
      opened: [openA.ok, openB.ok, openC.ok],
      ...(await cdp.eval('window.__oct.state()')),
    }
    await cdp.shot('three-tabs')

    // 2. 切换：点第 1 个标签，内容要换成 index.html，其它标签保留
    const clicked = await cdp.eval(`window.__oct.clickTab('index.html')`)
    await sleep(500)
    result.checks.switchBack = { clicked, ...(await cdp.eval('window.__oct.state()')) }

    // 3. 同一个文件再点一次：不能多出重复标签
    await cdp.eval(`window.__oct.open('code.py')`)
    await cdp.eval(`window.__oct.open('code.py')`)
    await sleep(300)
    result.checks.noDuplicate = await cdp.eval('window.__oct.tabs()')

    // 4. 滚动位置各自独立：用 3 万行的大 HTML 滚一下 → 切到别的 → 切回来
    await cdp.eval(`window.__oct.open('big.html')`)
    await sleep(1200)
    await cdp.eval(`window.__oct.scrollActive(4000)`)
    await sleep(400)
    const scrolledTop = await cdp.eval('window.__oct.state()')
    await cdp.eval(`window.__oct.clickTab('data.json')`)
    await sleep(400)
    await cdp.eval(`window.__oct.clickTab('big.html')`)
    await sleep(600)
    const restoredTop = await cdp.eval('window.__oct.state()')
    result.checks.scrollPerTab = {
      before: scrolledTop.scrollTop,
      after: restoredTop.scrollTop,
      kept: scrolledTop.scrollTop > 1000 && Math.abs(restoredTop.scrollTop - scrolledTop.scrollTop) < 5,
      tabCount: restoredTop.tabs.length,
    }

    // 5. 编辑草稿跨标签保留：进编辑、改字、切走、切回
    await cdp.eval(`window.__oct.open('data.json')`)
    await sleep(400)
    await cdp.eval(`document.querySelector('.editor-slot:not([style*="display: none"]) .code-scroll')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await sleep(700)
    const editStarted = await cdp.eval(`!!document.querySelector('.editor-slot:not([style*="display: none"]) .code-edit-area')`)
    await cdp.eval(`(() => {
      const area = document.querySelector('.editor-slot:not([style*="display: none"]) .code-edit-area')
      if (!area) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(area, 'DRAFT-未保存的改动')
      area.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(300)
    await cdp.eval(`window.__oct.clickTab('index.html')`)
    await sleep(400)
    await cdp.eval(`window.__oct.clickTab('data.json')`)
    await sleep(500)
    const draftAfter = await cdp.eval('window.__oct.state()')
    result.checks.draftKept = {
      editStarted,
      editing: draftAfter.editing,
      draft: draftAfter.draft,
      dirtyDot: draftAfter.tabs.find((tab) => tab.name === 'data.json')?.dirty ?? null,
    }
    await cdp.shot('draft-kept')

    // 6. 关闭一个标签：只剩其余；关的是激活标签时激活相邻的
    const closeB = await cdp.eval(`window.__oct.closeTab('index.html')`)
    await sleep(400)
    result.checks.closeOne = { closed: closeB, ...(await cdp.eval('window.__oct.state()')) }

    // 7. 关闭全部：回到「选择左侧文件查看」
    const closeAll = await cdp.eval(`window.__oct.clickCloseAll()`)
    await sleep(500)
    result.checks.closeAll = {
      clicked: closeAll,
      tabs: await cdp.eval('window.__oct.tabs()'),
      empty: await cdp.eval(`document.querySelector('.editor-empty')?.innerText ?? null`),
    }
    await cdp.shot('closed-all')

    // 8. 清掉未保存标记，免得影响后面的手动使用
    await cdp.eval(`window.__oct.open('index.html')`)
    await sleep(400)

    console.log(JSON.stringify(result, null, 2))
    writeFileSync(path.join(OUT_DIR, 'verify-file-tabs.json'), JSON.stringify(result, null, 2))
  } finally {
    if (cdp) await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
    if (edge) {
      spawn('taskkill', ['/pid', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
      edge.kill()
    }
  }
}

main().catch((err) => {
  console.error('验证失败：', err.message)
  process.exit(1)
})
