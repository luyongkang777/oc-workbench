/**
 * 真机构建产物验收：直接托管 dist（就是 exe 内嵌的那份），
 * 用 headless Edge 手机视口打开，验证多项目标签在手机上全部可见。
 *
 * 和 verify-mobile-projects.mjs 的区别：
 *   - 那个跑 vite dev（源码），这个跑 dist（构建产物，exe 里嵌的就是它）
 *   - 这个把静态文件、mock API、/local/projects 放在同一个端口上，
 *     就是手机远程访问 exe 的真实拓扑
 *
 * 用法：node scripts/verify-mobile-projects-dist.mjs
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
const PROFILE = join(OUT_DIR, `edge-profile-dist-${process.pid}`)
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const PORT = 28995
const CDP_PORT = 9336
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
  id: 'ses_mock_dist',
  title: '构建产物验收',
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
  '.json': 'application/json; charset=utf-8',
}

function sendJson(res, status, body) {
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

  // ---- mock opencode 后端 ----
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

  // ---- 项目清单：同源 HTTP，就是远程访问时走的那条 ----
  if (path === '/local/projects') {
    if (method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"ok":true}')
    }
    return sendJson(res, 200, PROJECTS)
  }
  // 强制规则状态：RulesPanel 会读 status.global.items / status.local.items，
  // 只回 {} 会让整个 App 在渲染期抛错白屏（不是 CSS 问题）。
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

  // ---- dist 静态文件 ----
  let file = path === '/' ? '/index.html' : path
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

const SNAPSHOT = `(() => {
  const app = document.querySelector('.app')
  const box = document.querySelector('.project-tabs')
  const tabs = [...document.querySelectorAll('.project-tab')]
  const active = document.querySelector('.project-tab.active')
  const boxRect = box ? box.getBoundingClientRect() : null
  const nameOf = (el) => el.querySelector('.project-tab-name')?.textContent ?? ''
  const topbar = document.querySelector('.topbar')
  return {
    mobile: app?.getAttribute('data-mobile') === '1',
    topbarH: Math.round(topbar?.getBoundingClientRect().height ?? 0),
    count: tabs.length,
    names: tabs.map(nameOf),
    visible: tabs.filter((el) => {
      const st = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
    }).map(nameOf),
    active: active ? nameOf(active) : null,
    overflowX: box ? getComputedStyle(box).overflowX : null,
    scrollWidth: box?.scrollWidth ?? 0,
    clientWidth: box?.clientWidth ?? 0,
    activeInView: active && boxRect
      ? (() => {
          const r = active.getBoundingClientRect()
          return r.left >= boxRect.left - 1 && r.right <= boxRect.right + 1
        })()
      : null,
    winControlsH: Math.round(document.querySelector('.win-controls')?.getBoundingClientRect().height ?? 0),
  }
})()`

const clickTab = (name) => `(() => {
  const tab = [...document.querySelectorAll('.project-tab')]
    .find((el) => el.querySelector('.project-tab-name')?.textContent === ${JSON.stringify(name)});
  if (!tab) return false;
  tab.click();
  return true;
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
  console.log(`[dist] http://127.0.0.1:${PORT}`)

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
  console.log('[edge] CDP 就绪')

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
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  })

  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('oc-workbench:root', ${JSON.stringify(ROOT.replace(/\\/g, '/'))})`,
  })
  await cdp.send('Page.reload', { ignoreCache: true })
  await cdp.waitFor(`document.querySelectorAll('.project-tab').length > 0`, 30_000, '项目标签出现')
  await sleep(1500)
  console.log('[ui] 就绪')

  let st = await cdp.evaluate(SNAPSHOT)
  check('手机断点生效', st.mobile === true, `data-mobile=${st.mobile}`)
  check('三个项目全部渲染', st.count === 3, `count=${st.count} names=${st.names.join(',')}`)
  check('三个项目全部可见（修复前只剩当前一个）', st.visible.length === 3, `visible=${st.visible.join(',')}`)
  check('顶栏变两行（高度 > 60）', st.topbarH > 60, `topbarH=${st.topbarH}px`)
  check('标签条允许横滑', st.overflowX === 'auto' || st.overflowX === 'scroll', `overflow-x=${st.overflowX}`)
  // 窗口按钮只在 exe 外壳里渲染（浏览器没有 IPC）；高度为 0 说明是浏览器，跳过这条
  check(
    '窗口按钮没被撑高（exe 才检查，≤ 40）',
    st.winControlsH === 0 || st.winControlsH <= 40,
    st.winControlsH === 0 ? '浏览器无窗口按钮，跳过' : `winControlsH=${st.winControlsH}px`,
  )

  const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT_DIR, 'dist-mobile-projects.png'), Buffer.from(shot1.data, 'base64'))
  console.log(`[shot] ${join(OUT_DIR, 'dist-mobile-projects.png')}`)

  // 切到最后一个项目
  const lastName = st.names[st.names.length - 1]
  const clicked = await cdp.evaluate(clickTab(lastName))
  await sleep(1600)
  st = await cdp.evaluate(SNAPSHOT)
  check('点最后一个项目能切过去', clicked === true && st.active === lastName, `点击=${lastName} active=${st.active}`)
  check('切换后仍然三个标签', st.count === 3 && st.visible.length === 3, `count=${st.count} visible=${st.visible.length}`)
  check('切过去的标签在可视区', st.activeInView === true, `active=${st.active}`)

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
    /* Edge 没退干净会锁住 profile */
  }
  process.exit(exitCode)
}
