/**
 * 手机布局全量回归：所有宽度下不能横向溢出、底部导航要在、聊天区不能被顶栏挤没。
 *
 * 用 dist 构建产物跑（就是 exe 里嵌的那份），自己起静态服务 + mock API。
 * 这是 verify-mobile.mjs 的自包含版：那个依赖外部 vite / exe CDP，跑之前要手工准备。
 *
 * 用法：node scripts/verify-mobile-layout-dist.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WORKBENCH = join(HERE, '..')
const DIST = join(WORKBENCH, 'dist')
const OUT_DIR = join(WORKBENCH, '.tmp')
const PROFILE = join(OUT_DIR, `edge-profile-layout-${process.pid}`)
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const PORT = 28997
const CDP_PORT = 9338
const ROOT = WORKBENCH

mkdirSync(OUT_DIR, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MODEL = {
  id: 'mock-model',
  providerID: 'mock',
  name: 'Mock 1M',
  limit: { context: 1_000_000, output: 32_000 },
}
const SESSION = {
  id: 'ses_mock_layout',
  title: '布局回归',
  location: { directory: ROOT },
  metadata: { source: 'oc-workbench' },
  model: { id: MODEL.id, providerID: MODEL.providerID },
  time: { created: Date.now() - 60_000, updated: Date.now() },
}
const PROJECTS = [
  { path: ROOT, name: 'workbench', lastUsed: 3_000_000 },
  { path: 'F:\\游戏分析', name: '游戏分析', lastUsed: 2_000_000 },
  { path: 'F:\\梦幻西游', name: '梦幻西游', lastUsed: 1_000_000 },
]

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

const sendJson = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (path === '/api/info') return sendJson(res, 200, { version: 'mock' })
  if (path === '/api/event') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(': mock\n\n')
    return
  }
  if (path === '/api/model') return sendJson(res, 200, { data: [MODEL] })
  if (path === '/api/model/default') return sendJson(res, 200, { data: MODEL })
  if (path === '/api/agent') return sendJson(res, 200, { data: [{ id: 'build', name: 'build' }] })
  if (path === '/api/command') return sendJson(res, 200, { data: [] })
  if (path === '/api/mcp') return sendJson(res, 200, { data: [] })
  if (path === '/api/shell') return sendJson(res, 200, { data: [] })
  if (path === '/api/session') {
    if (method === 'POST') return sendJson(res, 200, { data: SESSION })
    return sendJson(res, 200, { data: [SESSION], cursor: {} })
  }
  const m = /^\/api\/session\/([^/]+)(?:\/(.+))?$/.exec(path)
  if (m) {
    if (decodeURIComponent(m[1]) !== SESSION.id) return sendJson(res, 404, { error: 'unknown' })
    return sendJson(res, 200, { data: m[2] ? [] : SESSION })
  }

  if (path === '/local/projects') {
    if (method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"ok":true}')
    }
    return sendJson(res, 200, PROJECTS)
  }
  // RulesPanel 渲染期读 status.global.items，缺了会白屏
  if (path === '/local/rules/status') {
    const empty = { items: [], path: '' }
    return sendJson(res, 200, {
      global: empty,
      local: empty,
      loaded: { global: 0, local: 0 },
      missing: { global: 0, local: 0 },
    })
  }
  if (path.startsWith('/local/')) return sendJson(res, 200, { matches: [], entries: [], data: [] })

  const file = path === '/' ? '/index.html' : path
  const abs = join(DIST, decodeURIComponent(file))
  if (!abs.startsWith(DIST) || !existsSync(abs)) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    return res.end('not found')
  }
  const body = readFileSync(abs)
  res.writeHead(200, {
    'content-type': MIME[extname(abs)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
})

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (!msg.id) return
      const slot = this.pending.get(msg.id)
      if (!slot) return
      this.pending.delete(msg.id)
      if (msg.error) slot.reject(new Error(`${msg.error.message} (${msg.error.code})`))
      else slot.resolve(msg.result)
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`CDP 超时：${method}`))
      }, 30_000)
    })
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (r.exceptionDetails) {
      throw new Error(`页面执行失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    }
    return r.result?.value
  }
  async waitFor(expression, timeoutMs = 20_000, label = expression) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return
      await sleep(150)
    }
    throw new Error(`等待超时：${label}`)
  }
}

async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res?.ok) return
    } catch {
      /* retry */
    }
    await sleep(200)
  }
  throw new Error(`服务没起来：${url}`)
}

const children = []
const track = (child) => (children.push(child), child)

const LAYOUT = `(() => {
  const doc = document.documentElement;
  const app = document.querySelector('.app');
  const nav = document.querySelector('.mobile-nav');
  const topbar = document.querySelector('.topbar');
  const chat = document.querySelector('.chat-input-wrap');
  const tabs = [...document.querySelectorAll('.project-tab')];
  const visibleTabs = tabs.filter((el) => {
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return st.display !== 'none' && r.width > 0;
  });
  return {
    mobile: app?.getAttribute('data-mobile') === '1',
    docWidth: doc.scrollWidth,
    viewWidth: window.innerWidth,
    overflow: doc.scrollWidth - window.innerWidth,
    hasNav: !!nav && getComputedStyle(nav).display !== 'none',
    topbarH: Math.round(topbar?.getBoundingClientRect().height ?? 0),
    chatBottom: Math.round(chat?.getBoundingClientRect().bottom ?? 0),
    viewHeight: window.innerHeight,
    visibleTabs: visibleTabs.length,
    totalTabs: tabs.length,
  };
})()`

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[ok]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`)
}

let exitCode = 0
try {
  if (!existsSync(EDGE)) throw new Error(`找不到 Edge：${EDGE}`)
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist 不存在，先跑 npm run build')

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))

  rmSync(PROFILE, { recursive: true, force: true })
  track(
    spawn(
      EDGE,
      [
        '--headless=new',
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${PROFILE}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--hide-scrollbars',
        '--window-size=390,844',
        'about:blank',
      ],
      { stdio: 'ignore' },
    ),
  )
  await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 30_000)

  const created = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/`)}`,
    { method: 'PUT' },
  )
  const target = await created.json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP 连不上')), { once: true })
  })
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('oc-workbench:root', ${JSON.stringify(ROOT.replace(/\\/g, '/'))})`,
  })

  // 逐个视口验：竖屏几个主流尺寸 + 横屏 + 极窄折叠屏
  const VIEWPORTS = [
    [280, 653, '折叠屏外屏'],
    [320, 640, 'iPhone SE 一代'],
    [360, 780, '安卓主流'],
    [390, 844, 'iPhone 14'],
    [414, 896, 'iPhone 11'],
    [568, 320, '横屏小机'],
    [844, 390, '横屏 iPhone 14'],
    [768, 1024, 'iPad 竖屏'],
  ]

  for (const [w, h, label] of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: 2,
      mobile: true,
    })
    await cdp.send('Page.reload', { ignoreCache: true })
    await cdp.waitFor(`!!document.querySelector('.app')`, 25_000, `${w}x${h} 应用挂载`)
    await sleep(900)

    const st = await cdp.evaluate(LAYOUT)
    const tag = `${w}x${h} ${label}`
    check(`${tag}：无横向溢出`, st.overflow <= 1, `溢出 ${st.overflow}px（文档 ${st.docWidth} / 视口 ${st.viewWidth}）`)
    check(`${tag}：底部导航在`, st.hasNav === true)
    check(
      `${tag}：聊天输入区没被顶栏挤没`,
      st.chatBottom > 0 && st.chatBottom <= st.viewHeight + 1,
      `输入区底部 ${st.chatBottom} / 视口高 ${st.viewHeight}`,
    )
    check(`${tag}：顶栏没失控（≤ 110px）`, st.topbarH <= 110, `顶栏高 ${st.topbarH}px`)

    // 竖屏高视口要求三个项目都看得见；横屏/极窄允许横滑
    if (h >= 561 && w >= 360) {
      const full = st.visibleTabs === 3 && st.totalTabs === 3
      const scrollable = await cdp.evaluate(`(() => {
        const b = document.querySelector('.project-tabs');
        return !!b && b.scrollWidth > b.clientWidth + 1;
      })()`)
      check(
        `${tag}：多项目看得见（全显或可横滑）`,
        full || scrollable,
        `可见 ${st.visibleTabs}/${st.totalTabs} 可横滑=${scrollable}`,
      )
    }
  }

  // 竖屏截图留证
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  })
  await cdp.send('Page.reload', { ignoreCache: true })
  await cdp.waitFor(`!!document.querySelector('.app')`, 25_000, '截图前应用挂载')
  await sleep(1200)
  const shotRes = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const shotPath = join(OUT_DIR, 'layout-390x844.png')
  writeFileSync(shotPath, Buffer.from(shotRes.data, 'base64'))
  console.log(`[shot] ${shotPath}`)

  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) exitCode = 1
} catch (err) {
  console.error(`[fail] ${err.message}`)
  exitCode = 1
} finally {
  for (const child of children) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }
  try {
    server.close()
  } catch {
    /* 没起来时 close 会抛 */
  }
  await sleep(400)
  try {
    rmSync(PROFILE, { recursive: true, force: true })
  } catch {
    /* Edge 没退干净会锁 profile */
  }
  process.exit(exitCode)
}
