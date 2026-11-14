// 全格式文件查看验收：用 headless Edge 走 CDP，把 .tmp/formats 下每种文件都点开，
// 记录「实际渲染成了什么」（源码 / Markdown 预览 / 图片 / 十六进制 / HTML 预览 / 报错）。
//
// 用法：
//   1) dev：先起 vite（127.0.0.1:5273），再 `node scripts/verify-formats.mjs`
//   2) exe：带 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9231 启动 exe，
//      再 `$env:OCW_CDP_PORT=9231; node scripts/verify-formats.mjs`（不另起 Edge，直接连真机）
// 产物：`.tmp/verify-formats.json` + 关键截图。

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9334
const APP_URL = 'http://127.0.0.1:5273/'
const OUT_DIR = path.resolve('.tmp')

const FILES = [
  'note.md',
  'index.html',
  'big.html',
  'empty.html',
  'page.htm',
  'gbk-page.html',
  'data.json',
  'table.csv',
  'feed.xml',
  'logo.svg',
  'script.js',
  'styles.css',
  'code.py',
  'Makefile',
  'noext',
  'utf16.txt',
  'tiny.pdf',
  'pack.zip',
  'sample.bin',
]

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

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const message = { id, method, params }
    if (sessionId) message.sessionId = sessionId
    this.ws.send(JSON.stringify(message))
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
    const file = path.join(OUT_DIR, `verify-formats-${name}.png`)
    writeFileSync(file, Buffer.from(result.data, 'base64'))
    return file
  }
}

const PAGE_HELPERS = `
window.__ocf = {
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
      // 多标签后路径栏有好几份，看标签栏里哪个是激活的
      const label = document.querySelector('.file-tab.active .file-tab-name')?.textContent || ''
      if (label === name) return true
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    return false
  },
  // 文件树是虚拟列表：目标行可能还没挂载，要逐段滚动找。
  // 找到后必须「立即」点击：滚动会触发重渲染，旧行元素会被卸载，派发到游离节点没有反应。
  async findAndClick(name, timeout = 8000) {
    const started = performance.now()
    const scroll = document.querySelector('.tree-scroll')
    // 从当前滚动位置开始找（连续打开同一目录里的文件时几乎不用滚）
    let offset = scroll ? scroll.scrollTop : 0
    let direction = 1
    const step = scroll ? Math.max(160, scroll.clientHeight * 0.9) : 0
    while (performance.now() - started < timeout) {
      const row = this.row(name)
      if (row) {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return true
      }
      if (!scroll || step === 0) return false
      const maxTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
      offset += step * direction
      if (offset > maxTop) {
        offset = maxTop
        direction = -1
      } else if (offset < 0) {
        offset = 0
        direction = 1
      }
      scroll.scrollTop = offset
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    return false
  },
  // 确保目录展开：子行已经能看到就不用点（再点会把它折叠起来）。
  async ensureDir(dirName, childName) {
    const visible = (name) => !!this.row(name)
    if (visible(childName)) return true
    if (!(await this.findAndClick(dirName))) return false
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (visible(childName)) return true
    // 点了却没出现子行：多半本来展开、刚被折叠了，再点一次恢复
    if (!(await this.findAndClick(dirName))) return false
    await new Promise((resolve) => setTimeout(resolve, 500))
    return visible(childName)
  },
  async open(name, timeout = 20000) {
    const started = performance.now()
    if (!(await this.findAndClick(name))) return { ok: false, reason: 'row-not-found' }
    const ok = await this.waitPath(name, timeout)
    // 等「读取中…」消失，最多再等 2 秒
    const waitDone = Date.now() + 2000
    while (Date.now() < waitDone) {
      const body = this.activeSlot().querySelector('.editor')?.textContent || ''
      if (!body.includes('读取中…')) break
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    return { ok, elapsed: Math.round(performance.now() - started) }
  },
  /** 多标签后页面上同时有多个编辑器：统计只能落在当前激活的那个上。 */
  activeSlot() {
    return document.querySelector('.editor-slot:not([style*="display: none"])') ?? document.body
  },
  state() {
    const scope = this.activeSlot()
    const rows = [...scope.querySelectorAll('.code-line')]
    const frame = scope.querySelector('iframe.editor-frame')
    let frameText = null
    let frameTitle = null
    try {
      frameText = frame?.contentDocument?.body?.innerText?.slice(0, 200) ?? null
      frameTitle = frame?.contentDocument?.title ?? null
    } catch (err) {
      frameText = 'cross-origin-blocked'
    }
    return {
      path: scope.querySelector('.editor-path-text')?.textContent || '',
      text: (scope.querySelector('.editor')?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 260),
      lineRows: rows.length,
      firstText: rows[0]?.querySelector('.code-text')?.textContent?.slice(0, 80) ?? null,
      preview: !!scope.querySelector('.editor-preview'),
      previewText:
        scope.querySelector('.editor-preview')?.innerText?.replace(/\\s+/g, ' ').trim().slice(0, 160) ??
        null,
      image: !!scope.querySelector('.editor-image img'),
      imageWidth: scope.querySelector('.editor-image img')?.naturalWidth ?? 0,
      hex: scope.querySelector('.hex-dump')?.textContent?.slice(0, 60) ?? null,
      frame: !!frame,
      frameTitle,
      frameText,
      error: scope.querySelector('.editor-error')?.innerText?.slice(0, 160) ?? null,
      empty: scope.querySelector('.editor-empty')?.innerText?.slice(0, 80) ?? null,
      note: scope.querySelector('.editor-note')?.innerText?.slice(0, 160) ?? null,
      modes: [...scope.querySelectorAll('.editor-modes button')].map((b) => b.textContent),
      canClose: !!scope.querySelector('.editor-close'),
      tabCount: document.querySelectorAll('.file-tab').length,
    }
  },
  clickMode(label) {
    const scope = this.activeSlot()
    const button = [...scope.querySelectorAll('.editor-modes button')].find(
      (item) => item.textContent === label,
    )
    if (!button) return false
    button.click()
    return true
  },
  clickClose() {
    const button = this.activeSlot().querySelector('.editor-close')
    if (!button) return false
    button.click()
    return true
  },
};
true
`

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  // 连 exe 时不检查 dev server
  if (!process.env.OCW_CDP_PORT) await waitOk(APP_URL)

  // 连已启动的 exe（真机验收）时不另起 Edge、也不改 localStorage。
  const exePort = process.env.OCW_CDP_PORT ? Number(process.env.OCW_CDP_PORT) : null
  const port = exePort ?? DEBUG_PORT
  const userDataDir = path.join(process.env.TEMP || OUT_DIR, 'ocwb-edge-profile-formats')
  // cdp 提到外层：finally 里要清视口覆盖
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
    // sandbox 里是 opaque origin，父页面拿不到 contentDocument；
    // 只能靠 CDP 的帧执行上下文读 iframe 内部真值。
    // sandbox iframe 是 opaque origin，Chromium 把它放进独立进程（OOPIF），
    // 父页面的 executionContext 里看不到它，要附加到子 target 才有 sessionId。
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    })
    const frameTargets = []
    cdp.events.set('Target.attachedToTarget', [
      (params) => frameTargets.push({ sessionId: params.sessionId, type: params.targetInfo.type }),
    ])
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
      // 真机：界面已经加载好，直接注入探针。
      await cdp.eval(PAGE_HELPERS)
    } else {
      const loaded = cdp.once('Page.loadEventFired')
      await cdp.send('Page.navigate', { url: APP_URL })
      await loaded
      // 新 profile 没有最近项目，先指定工作区再重载，否则文件树不挂载。
      const reloaded = cdp.once('Page.loadEventFired')
      await cdp.eval(
        `window.localStorage.setItem('oc-workbench:root', ${JSON.stringify(path.resolve('.'))})`,
      )
      await cdp.send('Page.reload')
      await reloaded
      await cdp.eval(PAGE_HELPERS)
    }

    // 文件树首屏 + 展开 .tmp/formats
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
    // 树可能停在上次的滚动位置：先回顶部，再按「确保展开」的方式进目录。
    await cdp.eval(`(() => {
      const scroll = document.querySelector('.tree-scroll')
      if (scroll) scroll.scrollTop = 0
      return true
    })()`)
    await sleep(300)
    const tmpOk = await cdp.eval(`window.__ocf.ensureDir('.tmp', 'formats')`)
    const formatsOk = await cdp.eval(`window.__ocf.ensureDir('formats', 'index.html')`)
    if (!tmpOk || !formatsOk) {
      console.log(
        'tree:',
        await cdp.eval(`[...document.querySelectorAll('.tree-row')].map((r) => r.textContent)`),
      )
      throw new Error(`展开 .tmp/formats 失败（tmp=${tmpOk} formats=${formatsOk}）`)
    }
    await sleep(400)

    const result = { files: {} }
    for (const name of FILES) {
      console.log('[open]', name)
      const opened = await cdp.eval(`window.__ocf.open(${JSON.stringify(name)})`)
      await sleep(450)
      const state = await cdp.eval('window.__ocf.state()')
      result.files[name] = { ...opened, ...state }
      await cdp.shot(name.replace(/[^\w.-]/g, '_'))
    }

    // ---- HTML 专项：预览是否真的渲染、能否切源码、能否关闭 ----
    const checks = {}

    // ---- 打开即显示：源码视图不能停在 pending（只看到行号、要滚一下才出字） ----
    checks.pendingOnOpen = Object.entries(result.files)
      .filter(([, value]) => value.lineRows > 0 && value.firstText === ' ')
      .map(([name]) => name)

    const openHtml = await cdp.eval("window.__ocf.open('index.html')")
    await sleep(700)
    const htmlPreview = await cdp.eval('window.__ocf.state()')
    checks.htmlPreview = {
      ...openHtml,
      frame: htmlPreview.frame,
      frameTitle: htmlPreview.frameTitle,
      frameText: htmlPreview.frameText,
      preview: htmlPreview.preview,
      modes: htmlPreview.modes,
      canClose: htmlPreview.canClose,
    }
    await cdp.shot('html-preview')

    // 预览里的按钮要能点（脚本在沙盒里执行）：在 iframe 自己的执行上下文里跑
    const frameTarget = frameTargets[frameTargets.length - 1]
    checks.frameTargets = frameTargets.map((item) => item.type)
    if (!frameTarget) {
      checks.htmlScript = 'no-frame-target'
    } else {
      try {
        await cdp.send('Runtime.enable', {}, frameTarget.sessionId)
        const scriptResult = await cdp.send(
          'Runtime.evaluate',
          {
            expression: `(() => {
              const button = document.querySelector('button')
              if (!button) return 'no-button'
              button.click()
              return (document.title || '') + ' | ' + (document.getElementById('out')?.textContent ?? 'no-out')
            })()`,
            returnByValue: true,
          },
          frameTarget.sessionId,
        )
        checks.htmlScript = scriptResult.result?.value ?? JSON.stringify(scriptResult)
      } catch (err) {
        checks.htmlScript = 'frame-eval-failed: ' + err.message
      }
    }

    await cdp.eval("window.__ocf.clickMode('源码')")
    await sleep(500)
    const htmlSource = await cdp.eval('window.__ocf.state()')
    checks.htmlSource = { lineRows: htmlSource.lineRows, frame: htmlSource.frame, modes: htmlSource.modes }

    // 超大 HTML：默认停在源码（1 MB 硬上限），点「预览」给提示而不是硬渲染
    const openBig = await cdp.eval("window.__ocf.open('big.html')")
    await sleep(500)
    const bigState = await cdp.eval('window.__ocf.state()')
    await cdp.eval("window.__ocf.clickMode('预览')")
    await sleep(700)
    const bigPreview = await cdp.eval('window.__ocf.state()')
    checks.bigHtml = {
      ...openBig,
      defaultSource: bigState.lineRows > 0 && !bigState.frame,
      previewFrame: bigPreview.frame,
      note: bigPreview.note,
      modes: bigState.modes,
    }

    // 空 HTML：显示「空文件」，不能白屏
    const openEmpty = await cdp.eval("window.__ocf.open('empty.html')")
    await sleep(500)
    const emptyState = await cdp.eval('window.__ocf.state()')
    checks.emptyHtml = { ...openEmpty, empty: emptyState.empty, frame: emptyState.frame }

    // Markdown 预览不能被 HTML 分支抢走（共用 previewable，但渲染器不同）
    const openMd = await cdp.eval("window.__ocf.open('note.md')")
    await sleep(600)
    const mdState = await cdp.eval('window.__ocf.state()')
    checks.markdown = {
      ...openMd,
      preview: mdState.preview,
      frame: mdState.frame,
      previewText: mdState.previewText,
      modes: mdState.modes,
    }

    // GBK 编码的 HTML：预览不能乱码
    const openGbk = await cdp.eval("window.__ocf.open('gbk-page.html')")
    await sleep(600)
    const gbkState = await cdp.eval('window.__ocf.state()')
    const gbkTarget = frameTargets[frameTargets.length - 1]
    let gbkText = null
    if (gbkTarget) {
      try {
        await cdp.send('Runtime.enable', {}, gbkTarget.sessionId)
        const gbkResult = await cdp.send(
          'Runtime.evaluate',
          { expression: 'document.body ? document.body.innerText.slice(0, 120) : null', returnByValue: true },
          gbkTarget.sessionId,
        )
        gbkText = gbkResult.result?.value ?? null
      } catch (err) {
        gbkText = 'eval-failed: ' + err.message
      }
    }
    checks.gbkHtml = { ...openGbk, frame: gbkState.frame, frameText: gbkText }

    // 关闭按钮：多标签下点 × 只关当前这个，标签数要减一（不是把整个查看区清空）
    const tabsBefore = await cdp.eval(`document.querySelectorAll('.file-tab').length`)
    const closeOne = await cdp.eval('window.__ocf.clickClose()')
    await sleep(400)
    const afterClose = await cdp.eval(`({
      tabCount: document.querySelectorAll('.file-tab').length,
      active: document.querySelector('.file-tab.active .file-tab-name')?.textContent ?? null,
    })`)
    const openAgain = await cdp.eval("window.__ocf.open('data.json')")
    await sleep(300)
    const tabsBefore2 = await cdp.eval(`document.querySelectorAll('.file-tab').length`)
    const closeTwo = await cdp.eval('window.__ocf.clickClose()')
    await sleep(400)
    const afterClose2 = await cdp.eval(`({
      tabCount: document.querySelectorAll('.file-tab').length,
      active: document.querySelector('.file-tab.active .file-tab-name')?.textContent ?? null,
    })`)
    checks.close = {
      tabsBefore,
      closeOne,
      afterClose,
      closedOne: afterClose.tabCount === tabsBefore - 1,
      openAgain: openAgain.ok,
      tabsBefore2,
      closeTwo,
      afterClose2,
      closedTwo: afterClose2.tabCount === tabsBefore2 - 1,
    }

    // 收尾：把这一轮开的标签全关掉，别把界面留在十几个标签的状态里
    const closeAll = await cdp.eval(`(() => {
      const button = document.querySelector('.file-tabs-close-all')
      if (!button) return 'no-button'
      button.click()
      return 'clicked'
    })()`)
    await sleep(500)
    checks.closeAll = {
      clicked: closeAll,
      tabs: await cdp.eval(`document.querySelectorAll('.file-tab').length`),
      empty: await cdp.eval(`document.querySelector('.editor-empty')?.innerText ?? null`),
    }

    // × 的可见性：尺寸、颜色、伪元素内容（按钮本身没有文本节点）
    const openHtmlAgain = await cdp.eval("window.__ocf.open('index.html')")
    await sleep(500)
    checks.closeButton = await cdp.eval(`(() => {
      const button = window.__ocf.activeSlot().querySelector('.editor-close')
      if (!button) return { exists: false }
      const rect = button.getBoundingClientRect()
      const style = getComputedStyle(button)
      const before = getComputedStyle(button, '::before')
      return {
        exists: true,
        textContent: button.textContent,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        x: Math.round(rect.x),
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden',
        color: style.color,
        icon: before.content,
      }
    })()`)
    await cdp.shot('close-button')
    const closeFinal = await cdp.eval('window.__ocf.clickClose()')
    await sleep(300)
    checks.closeButton.closedAfter = closeFinal
    await cdp.shot('after-close')

    result.checks = checks
    console.log(JSON.stringify(result, null, 2))
    writeFileSync(path.join(OUT_DIR, 'verify-formats.json'), JSON.stringify(result, null, 2))
  } finally {
    // 恢复视口覆盖：否则脚本结束后页面还按 1500x950 渲染，看起来像窗口尺寸坏了。
    if (cdp) {
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
    }
    if (edge) {
      // 只杀主进程会留下渲染子进程占着 profile 目录，下次启动会卡住。
      spawn('taskkill', ['/pid', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
      edge.kill()
    }
  }
}

main().catch((err) => {
  console.error('验证失败：', err.message)
  process.exit(1)
})
