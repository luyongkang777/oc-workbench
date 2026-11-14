// HTML 预览内联验收：带外部 css/js/图片的页面要真的显示出样式和图片。
//   dev: node scripts/verify-html-preview.mjs
//   exe: $env:OCW_CDP_PORT=9231; node scripts/verify-html-preview.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9337
const APP_URL = 'http://127.0.0.1:5273/'
const OUT_DIR = path.resolve('.tmp')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitOk(url, timeoutMs = 40000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
    } catch {}
    await sleep(200)
  }
  throw new Error('等待超时 ' + url)
}

const PAGE_HELPERS = `
window.__och = {
  row(name) {
    return [...document.querySelectorAll('.tree-row')].find(
      (r) => r.querySelector('.tree-name')?.textContent === name,
    )
  },
  totalRows() {
    const box = document.querySelector('.tree-rows')
    return box ? Math.round(parseFloat(box.style.height || '0') / 24) : 0
  },
  async findAndClick(name, timeout = 10000) {
    const started = performance.now()
    const scroll = document.querySelector('.tree-scroll')
    let offset = scroll ? scroll.scrollTop : 0
    let dir = 1
    while (performance.now() - started < timeout) {
      const hit = this.row(name)
      if (hit) { hit.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true }
      if (!scroll) return false
      const step = Math.max(160, scroll.clientHeight * 0.9)
      const maxTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
      offset += step * dir
      if (offset > maxTop) { offset = maxTop; dir = -1 }
      else if (offset < 0) { offset = 0; dir = 1 }
      scroll.scrollTop = offset
      await new Promise((r) => setTimeout(r, 40))
    }
    return false
  },
  async ensureDir(name) {
    const before = this.totalRows()
    if (!(await this.findAndClick(name))) return false
    await new Promise((r) => setTimeout(r, 600))
    const after = this.totalRows()
    if (after > before) return true
    if (after === before) return false
    await this.findAndClick(name)
    await new Promise((r) => setTimeout(r, 600))
    return this.totalRows() >= before
  },
  activeSlot() {
    return document.querySelector('.editor-slot:not([style*="display: none"])') ?? document.body
  },
  async open(name, timeout = 20000) {
    if (!(await this.findAndClick(name))) return false
    const started = performance.now()
    while (performance.now() - started < timeout) {
      const label = document.querySelector('.file-tab.active .file-tab-name')?.textContent || ''
      if (label === name) return true
      await new Promise((r) => setTimeout(r, 40))
    }
    return false
  },
  clearTabs() {
    for (let i = 0; i < 20; i += 1) {
      const close = document.querySelector('.file-tab .file-tab-close')
      if (!close) break
      close.click()
    }
  },
};
true
`

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const exePort = process.env.OCW_CDP_PORT ? Number(process.env.OCW_CDP_PORT) : null
  if (!exePort) await waitOk(APP_URL)

  const port = exePort ?? DEBUG_PORT
  let cdp = null
  let nextId = 1
  const pendingCalls = new Map()
  const frameTargets = []
  const logs = []

  const userDataDir = path.join(process.env.TEMP || OUT_DIR, 'ocwb-edge-profile-htmlpreview')
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
    await waitOk(`http://127.0.0.1:${port}/json/version`, 20000)
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((r) => ws.addEventListener('open', r, { once: true }))

    ws.addEventListener('message', (event) => {
      const m = JSON.parse(event.data)
      if (m.id) {
        const slot = pendingCalls.get(m.id)
        if (!slot) return
        pendingCalls.delete(m.id)
        if (m.error) slot.reject(new Error(JSON.stringify(m.error)))
        else slot.resolve(m.result)
        return
      }
      if (m.method === 'Target.attachedToTarget') {
        frameTargets.push({ sessionId: m.params.sessionId, type: m.params.targetInfo.type })
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        logs.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
      }
      if (m.method === 'Runtime.exceptionThrown') {
        logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description ?? '').slice(0, 200))
      }
    })

    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const myId = nextId++
        pendingCalls.set(myId, { resolve, reject })
        const message = { id: myId, method, params }
        if (sessionId) message.sessionId = sessionId
        ws.send(JSON.stringify(message))
      })

    const evalExpr = async (expression, ms = 30000) => {
      const r = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: ms,
      })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
      return r.result.value
    }

    await send('Page.enable')
    await send('Runtime.enable')
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1500,
      height: 950,
      deviceScaleFactor: 1,
      mobile: false,
    })

    const waitLoad = () =>
      new Promise((resolve) => {
        const h = (event) => {
          const m = JSON.parse(event.data)
          if (m.method === 'Page.loadEventFired') {
            ws.removeEventListener('message', h)
            resolve()
          }
        }
        ws.addEventListener('message', h)
      })

    if (!exePort) {
      const loaded = waitLoad()
      await send('Page.navigate', { url: APP_URL })
      await loaded
      const reloaded = waitLoad()
      await evalExpr(
        `window.localStorage.setItem('oc-workbench:root', ${JSON.stringify(path.resolve('.')).replace(/"/g, "'")})`,
      )
      await send('Page.reload')
      await reloaded
    }
    await evalExpr(PAGE_HELPERS)
    await sleep(1500)

    // 展开 .tmp/formats
    await evalExpr(`(() => { const s = document.querySelector('.tree-scroll'); if (s) s.scrollTop = 0; return true })()`)
    await sleep(300)
    const tmpOk = await evalExpr(`window.__och.ensureDir('.tmp')`)
    const formatsOk = await evalExpr(`window.__och.ensureDir('formats')`)
    if (!tmpOk || !formatsOk) throw new Error(`展开目录失败 ${tmpOk}/${formatsOk}`)
    await evalExpr(`window.confirm = () => true; true`)

    const result = { checks: {} }
    await evalExpr(`window.__och.clearTabs()`)
    await sleep(400)

    // 1. 带外部资源的页面：CSS 生效 / 脚本执行 / 图片加载
    const opened = await evalExpr(`window.__och.open('with-assets.html')`)
    await sleep(1500)
    const meta = await evalExpr(`(() => {
      const slot = window.__och.activeSlot()
      const frame = slot.querySelector('iframe.editor-frame')
      const doc = frame?.getAttribute('srcdoc') || ''
      return JSON.stringify({
        opened: !!frame,
        srcdocLen: doc.length,
        cssInlined: doc.includes('data:text/css'),
        jsInlined: doc.includes('data:application/javascript') || doc.includes('data:text/javascript'),
        imgInlined: /data:image\\/png/.test(doc),
        stillHasRelCss: doc.includes('href="site.css"'),
        note: slot.querySelector('.editor-html-note')?.innerText ?? null,
      })
    })()`)
    result.checks.meta = { opened, ...JSON.parse(meta) }

    // 2. 在 iframe 自己的执行上下文里读渲染结果（sandbox 是 OOPIF，父页面读不到）
    const frameTarget = frameTargets[frameTargets.length - 1]
    result.checks.frameTargets = frameTargets.map((t) => t.type)
    if (frameTarget) {
      try {
        await send('Runtime.enable', {}, frameTarget.sessionId)
        const inner = await send(
          'Runtime.evaluate',
          {
            expression: `(() => {
              const h1 = document.querySelector('h1')
              const js = document.getElementById('from-js')
              const img = document.querySelector('img')
              const body = document.body
              return JSON.stringify({
                h1Text: h1?.textContent ?? null,
                h1Color: h1 ? getComputedStyle(h1).color : null,
                bodyBg: body ? getComputedStyle(body).backgroundColor : null,
                jsText: js?.textContent ?? null,
                imgWidth: img?.naturalWidth ?? 0,
                imgComplete: img?.complete ?? null,
              })
            })()`,
            returnByValue: true,
          },
          frameTarget.sessionId,
        )
        result.checks.rendered = JSON.parse(inner.result.value)
      } catch (err) {
        result.checks.rendered = 'eval-failed: ' + err.message
      }
    } else {
      result.checks.rendered = 'no-frame-target(WebView2 不暴露 OOPIF，只能看截图)'
    }

    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path.join(OUT_DIR, 'verify-html-preview.png'), Buffer.from(shot.data, 'base64'))

    // 3. 纯脚本渲染的空壳页面（工作区 index.html）：应该有说明，不是静默白屏
    const shellOpened = await evalExpr(`window.__och.open('app-shell.html')`)
    await sleep(1200)
    const shell = await evalExpr(`(() => {
      const slot = window.__och.activeSlot()
      const frame = slot.querySelector('iframe.editor-frame')
      const note = slot.querySelector('.editor-html-note')?.innerText ?? null
      return JSON.stringify({
        opened: !!frame,
        // 说明条要明确告诉用户「正文由脚本生成、预览可能空白」，
        // 不能静默白屏让人以为坏了
        explainsBlank: !!note && note.includes('脚本生成'),
        note,
      })
    })()`)
    result.checks.scriptOnlyShell = { opened: shellOpened, ...JSON.parse(shell) }
    const shot2 = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path.join(OUT_DIR, 'verify-html-preview-shell.png'), Buffer.from(shot2.data, 'base64'))

    result.checks.logs = logs.filter((line) => line.includes('exception')).slice(0, 5)
    await evalExpr(`window.__och.clearTabs()`)

    console.log(JSON.stringify(result, null, 2))
    writeFileSync(path.join(OUT_DIR, 'verify-html-preview.json'), JSON.stringify(result, null, 2))
    ws.close()
  } finally {
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
