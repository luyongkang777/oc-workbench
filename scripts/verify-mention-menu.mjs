/**
 * 菜单状态机回归验收（自包含：自己起 mock 后端 + vite + headless Edge）。
 *
 * 背景：单测只能测纯函数，测不到「调用处怎么解释返回值」。
 * 这里专门守住三个曾出过 bug 的路径。
 *
 * 覆盖四条：
 *   1. 打 `/` 出命令菜单
 *   2. 删掉 `/` 菜单必须关闭（回归点：null ?? current 会保持打开）
 *   3. 打 `/` 后按 Esc 菜单必须关闭（同上）
 *   4. 打 `@` 出文件候选，且 `/` → `@` 不会被抢走
 *
 * 用法：node scripts/verify-mention-menu.mjs（或 npm run verify:mention-menu）
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WORKBENCH = join(HERE, '..')
const OUT_DIR = join(WORKBENCH, '.tmp')
const PROFILE = join(OUT_DIR, `edge-profile-menu-${process.pid}`)
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const MOCK_PORT = 28993
const VITE_PORT = 5273
const CDP_PORT = 9332

mkdirSync(OUT_DIR, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MODEL = {
  id: 'mock-model',
  providerID: 'mock',
  name: 'Mock 1M',
  limit: { context: 1_000_000, output: 32_000 },
}
const SESSION = {
  id: 'ses_mock_menu',
  title: '菜单回归探针',
  location: { directory: 'F:\\opencode\\workbench' },
  metadata: { source: 'oc-workbench' },
  model: { id: MODEL.id, providerID: MODEL.providerID },
  time: { created: Date.now() - 60_000, updated: Date.now() },
}
const MENTIONS = [
  { path: 'src\\App.tsx', type: 'file' },
  { path: 'src\\main.tsx', type: 'file' },
  { path: 'package.json', type: 'file' },
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

  if (path === '/local/fs/mentions') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const hits = q ? MENTIONS.filter((m) => m.path.toLowerCase().includes(q)) : MENTIONS
    return sendJson(res, 200, { matches: hits })
  }

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
    this.events = []
    ws.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (!msg.id) {
        if (this.events.length < 200) this.events.push(msg)
        return
      }
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

const STATE = `(() => {
  const menu = document.querySelector('.chat-slash-menu')
  const items = document.querySelectorAll('.chat-slash-item')
  const area = document.querySelector('textarea.chat-input')
  return {
    menu: menu ? (menu.className.match(/files|commands|agents/)?.[0] ?? 'menu') : null,
    items: items.length,
    value: area ? area.value : null,
  };
})()`

const typeText = (text) => `(() => {
  const el = document.querySelector('textarea.chat-input');
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(text)});
  el.setSelectionRange(${text.length}, ${text.length});
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text.slice(-1))} }));
  return true;
})()`

const pressEsc = `(() => {
  const el = document.querySelector('textarea.chat-input');
  el.focus();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
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

  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve))
  console.log(`[mock] http://127.0.0.1:${MOCK_PORT}`)

  track(
    spawn(process.execPath, [join(WORKBENCH, 'node_modules', 'vite', 'bin', 'vite.js')], {
      cwd: WORKBENCH,
      env: { ...process.env, OC_WORKBENCH_TARGET: `http://127.0.0.1:${MOCK_PORT}` },
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
        '--window-size=1500,980',
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

  // 写 root（纯字符串）后重载，否则 onFindFiles 直接返回 []
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('oc-workbench:root', 'F:/opencode/workbench')`,
  })
  await cdp.send('Page.reload', { ignoreCache: true })
  await cdp.waitFor(`!!document.querySelector('textarea.chat-input')`, 30_000, '输入框出现')
  await sleep(1500)
  console.log('[ui] 就绪')

  // 1) 打 / 出命令菜单
  await cdp.evaluate(typeText(''))
  await sleep(250)
  await cdp.evaluate(typeText('/'))
  await sleep(600)
  let st = await cdp.evaluate(STATE)
  check('打 / 出命令菜单', st.menu !== null && st.menu !== 'files' && st.items > 0, `menu=${st.menu} items=${st.items}`)

  // 2) 删掉 / 菜单必须关闭
  await cdp.evaluate(typeText(''))
  await sleep(700)
  st = await cdp.evaluate(STATE)
  check('删掉 / 后命令菜单关闭', st.menu === null, `menu=${st.menu}`)

  // 3) 打 / 后按 Esc 必须关闭
  await cdp.evaluate(typeText('/'))
  await sleep(600)
  st = await cdp.evaluate(STATE)
  const beforeEsc = st.menu
  await cdp.evaluate(pressEsc)
  await sleep(500)
  st = await cdp.evaluate(STATE)
  check('Esc 关闭命令菜单', st.menu === null, `Esc 前=${beforeEsc} Esc 后=${st.menu}`)

  // 4) @ 候选稳定
  await cdp.evaluate(typeText(''))
  await sleep(250)
  await cdp.evaluate(typeText('@'))
  await sleep(900)
  st = await cdp.evaluate(STATE)
  check('打 @ 出文件候选', st.menu === 'files' && st.items > 0, `menu=${st.menu} items=${st.items}`)

  // 5) / → @ 不被抢走
  await cdp.evaluate(typeText('/'))
  await sleep(500)
  await cdp.evaluate(typeText('@'))
  await sleep(900)
  st = await cdp.evaluate(STATE)
  check('/ 改成 @ 后文件菜单还在', st.menu === 'files' && st.items > 0, `menu=${st.menu} items=${st.items}`)

  // 6) 删掉 @ 菜单必须关闭
  await cdp.evaluate(typeText(''))
  await sleep(700)
  st = await cdp.evaluate(STATE)
  check('删掉 @ 后文件菜单关闭', st.menu === null, `menu=${st.menu}`)

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
  mock.close()
  await sleep(400)
  rmSync(PROFILE, { recursive: true, force: true })
  process.exit(exitCode)
}
