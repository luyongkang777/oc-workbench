/**
 * 手机端多项目标签验收（自包含：自己起 mock 后端 + vite + headless Edge）。
 *
 * 守的是这条回归：
 *   手机上 `.project-tab:not(.active){display:none}` 把非当前项目全藏了，
 *   用户切一个项目就以为上一个被「关掉」，永远只看得到一个。
 *
 * 现在要求：
 *   1. 390px 视口下三个项目标签全部可见（不是只剩当前一个）
 *   2. 标签条横向可滑（宽度不够时能滑到后面的项目）
 *   3. 滑到最右，最后一个标签完整可见
 *   4. 点最后一个标签能切过去，且它自动滚进可视区
 *   5. 切完仍然是三个标签（没有「打开一个关一个」）
 *
 * 项目清单用临时文件（OC_WORKBENCH_PROJECTS_FILE），不碰真实 projects.json。
 *
 * 用法：node scripts/verify-mobile-projects.mjs（或 npm run verify:mobile-projects）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WORKBENCH = join(HERE, '..')
const OUT_DIR = join(WORKBENCH, '.tmp')
const PROFILE = join(OUT_DIR, `edge-profile-mobile-projects-${process.pid}`)
const PROJECTS_FILE = join(OUT_DIR, `projects-mobile-${process.pid}.json`)
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const MOCK_PORT = 28994
const VITE_PORT = 5273
const CDP_PORT = 9334
// 用脚本所在仓库的真实路径：换机器/换盘符也能跑，不写死 F:\opencode\workbench
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
  id: 'ses_mock_mobile_projects',
  title: '手机多项目探针',
  location: { directory: ROOT },
  metadata: { source: 'oc-workbench' },
  model: { id: MODEL.id, providerID: MODEL.providerID },
  time: { created: Date.now() - 60_000, updated: Date.now() },
}

// 三个真实存在的目录：切换时后端探测不会因为路径不存在而把项目剔掉。
// lastUsed 用固定值，保证初始顺序确定：workbench → src → scripts。
const PROJECTS = [
  { path: ROOT, name: 'workbench', lastUsed: 3_000_000 },
  { path: join(ROOT, 'src'), name: 'src', lastUsed: 2_000_000 },
  { path: join(ROOT, 'scripts'), name: 'scripts', lastUsed: 1_000_000 },
]

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

const mock = createServer((req, res) => {
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

  const match = /^\/api\/session\/([^/]+)(?:\/(.+))?$/.exec(path)
  if (match) {
    const id = decodeURIComponent(match[1])
    const sub = match[2] ?? ''
    if (id !== SESSION.id) return sendJson(res, 404, { error: `unknown ${id}` })
    if (!sub) return sendJson(res, 200, { data: SESSION })
    return sendJson(res, 200, { data: [] })
  }

  if (path.startsWith('/local/')) return sendJson(res, 200, { matches: [], entries: [], data: [] })
  sendJson(res, 404, { error: `mock: no route ${method} ${path}` })
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
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error(`页面执行失败：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    }
    return result.result?.value
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
  return {
    mobile: app?.getAttribute('data-mobile') === '1',
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
    scrollLeft: Math.round(box?.scrollLeft ?? 0),
    activeInView: active && boxRect
      ? (() => {
          const r = active.getBoundingClientRect()
          return r.left >= boxRect.left - 1 && r.right <= boxRect.right + 1
        })()
      : null,
  }
})()`

const clickTab = (name) => `(() => {
  const tab = [...document.querySelectorAll('.project-tab')]
    .find((el) => el.querySelector('.project-tab-name')?.textContent === ${JSON.stringify(name)});
  if (!tab) return false;
  tab.click();
  return true;
})()`

const scrollToEnd = `(() => {
  const box = document.querySelector('.project-tabs');
  if (!box) return false;
  box.scrollLeft = box.scrollWidth;
  return true;
})()`

const lastTabInView = `(() => {
  const box = document.querySelector('.project-tabs');
  const tabs = [...document.querySelectorAll('.project-tab')];
  const last = tabs[tabs.length - 1];
  if (!box || !last) return false;
  const b = box.getBoundingClientRect();
  const r = last.getBoundingClientRect();
  return r.left >= b.left - 1 && r.right <= b.right + 1;
})()`

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT_DIR, name)
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`[shot] ${file}`)
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '[ok]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`)
}

let exitCode = 0
try {
  if (!existsSync(EDGE)) throw new Error(`找不到 Edge：${EDGE}`)

  writeFileSync(PROJECTS_FILE, JSON.stringify(PROJECTS), 'utf8')

  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve))
  console.log(`[mock] http://127.0.0.1:${MOCK_PORT}`)

  track(
    spawn(process.execPath, [join(WORKBENCH, 'node_modules', 'vite', 'bin', 'vite.js')], {
      cwd: WORKBENCH,
      env: {
        ...process.env,
        OC_WORKBENCH_TARGET: `http://127.0.0.1:${MOCK_PORT}`,
        // 清单隔离到临时文件：不污染真实 projects.json，也不被真实清单干扰
        OC_WORKBENCH_PROJECTS_FILE: PROJECTS_FILE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )
  await waitHttp(`http://127.0.0.1:${VITE_PORT}/`, 40_000)
  console.log('[vite] 就绪')

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
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(`http://127.0.0.1:${VITE_PORT}/`)}`,
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

  // 手机视口：触发 data-mobile='1' 与 mobile.css
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
  await sleep(1200)
  console.log('[ui] 就绪')

  let st = await cdp.evaluate(SNAPSHOT)
  check('手机断点生效', st.mobile === true, `data-mobile=${st.mobile}`)
  check('三个项目标签全部渲染', st.count === 3, `count=${st.count} names=${st.names.join(',')}`)
  check(
    '三个项目标签全部可见（修复前只剩当前一个）',
    st.visible.length === 3,
    `visible=${st.visible.join(',')}`,
  )
  await shot(cdp, 'mobile-projects-topbar.png')

  check(
    '标签条允许横向滚动（不是 overflow: hidden）',
    st.overflowX === 'auto' || st.overflowX === 'scroll',
    `overflow-x=${st.overflowX} scrollWidth=${st.scrollWidth} clientWidth=${st.clientWidth}`,
  )

  // 滑到最右：最后一个项目必须完整露出来
  await cdp.evaluate(scrollToEnd)
  await sleep(400)
  const lastVisible = await cdp.evaluate(lastTabInView)
  check('横滑到最右能看到最后一个项目', lastVisible === true, `scrollLeft=${(await cdp.evaluate(SNAPSHOT)).scrollLeft}`)

  // 点最后一个标签：能切过去，且自动滚进可视区
  st = await cdp.evaluate(SNAPSHOT)
  const lastName = st.names[st.names.length - 1]
  const clicked = await cdp.evaluate(clickTab(lastName))
  await sleep(1600)
  st = await cdp.evaluate(SNAPSHOT)
  check('点最后一个项目能切过去', clicked === true && st.active === lastName, `点击=${lastName} active=${st.active}`)
  check('切过去的标签在可视区内', st.activeInView === true, `scrollLeft=${st.scrollLeft}`)

  // 切完仍然是三个标签，没有「打开一个关一个」
  check('切换后仍然三个标签', st.count === 3 && st.visible.length === 3, `count=${st.count} visible=${st.visible.length}`)

  // 再切到另一个项目（切项目会把它提到第一位，不能写死索引）
  const other = st.names.find((name) => name !== st.active)
  const clickedOther = await cdp.evaluate(clickTab(other))
  await sleep(1600)
  st = await cdp.evaluate(SNAPSHOT)
  check('再切到另一个项目', clickedOther === true && st.active === other, `点击=${other} active=${st.active}`)
  check('再切后仍然三个标签', st.count === 3 && st.visible.length === 3, `count=${st.count} visible=${st.visible.length}`)

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
    mock.close()
  } catch {
    /* 端口没起来时 close 会抛 ERR_SERVER_NOT_RUNNING，别盖住真实错误 */
  }
  await sleep(400)
  try {
    rmSync(PROFILE, { recursive: true, force: true })
  } catch {
    /* Edge 还没完全退出时 profile 可能被锁，下次跑会覆盖 */
  }
  try {
    rmSync(PROJECTS_FILE, { force: true })
  } catch {
    /* 临时清单删不掉不影响结论 */
  }
  process.exit(exitCode)
}
