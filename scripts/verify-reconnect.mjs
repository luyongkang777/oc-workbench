// 「打开就未连接、且一直连不上」的端到端验证。
//
// 用一个假外壳（本地 HTTP，静态托管 dist/）复现两种真实故障：
//   backend-down：第一次探活就 502（后端晚起），要求页面自己重连成功——不能靠点按钮；
//   auth-drop：外壳前两次不回 oc:auth（IPC 桥晚就绪 / 消息丢了），要求页面自己补握手。
//
// 用法：node .tmp/verify-reconnect.mjs（先 npm run build）

import http from 'node:http'
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DIST = path.resolve('dist')
const OUT = path.resolve('.tmp')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 假外壳：静态页面 + /api 的三个端点。dropAuth = 前几次 oc:auth 故意不回。 */
function startMock(port, { scenario, dropAuth }) {
  const stats = { infoOk: 0, infoFail: 0, reconnects: 0, authSent: 0, stateCalls: 0 }
  const bootstrap = `<script>
(function () {
  var count = 0
  var drop = ${dropAuth}
  window.ipc = {
    postMessage: function (message) {
      if (message !== 'oc:auth') return
      count += 1
      try { fetch('/__auth?n=' + count, { method: 'POST' }) } catch (e) {}
      if (count <= drop) return
      setTimeout(function () { if (window.__ocIpc) window.__ocIpc('token:mock-token') }, 10)
    }
  }
})()
</script>`

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const route = url.pathname

    if (route === '/api/info') {
      // auth-drop 场景后端一直是好的，只测握手；backend-down 先 502，重连过一次才通。
      const up = scenario === 'auth-drop' || stats.reconnects > 0
      if (up) {
        stats.infoOk += 1
        return json(res, 200, { ok: true })
      }
      stats.infoFail += 1
      return json(res, 502, { error: '未连接：本地 opencode 后端不可用' })
    }
    if (route === '/api/state') {
      stats.stateCalls += 1
      const up = scenario === 'auth-drop' || stats.reconnects > 0
      return json(res, 200, {
        connected: up,
        base: up ? 'http://127.0.0.1:9' : null,
        error: up ? null : '后端未就绪（模拟）',
      })
    }
    if (route === '/api/reconnect') {
      stats.reconnects += 1
      return json(res, 200, { ok: true, base: 'http://127.0.0.1:9' })
    }
    if (route === '/__auth') {
      stats.authSent += 1
      return json(res, 200, { ok: true })
    }
    if (route.startsWith('/api/') || route.startsWith('/local/')) {
      return json(res, 502, { error: `mock 未实现：${route}` })
    }
    if (route === '/__stats') return json(res, 200, stats)

    // 静态资源
    const rel = route === '/' ? 'index.html' : decodeURIComponent(route.replace(/^\//, ''))
    const file = path.join(DIST, rel)
    if (!file.startsWith(DIST) || !existsSync(file)) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    let body = readFileSync(file)
    if (rel === 'index.html') {
      body = Buffer.from(
        body.toString('utf8').replace('</head>', `${bootstrap}</head>`),
        'utf8',
      )
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, stats }))
  })
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id) return
      const slot = this.pending.get(message.id)
      if (!slot) return
      this.pending.delete(message.id)
      if (message.error) slot.reject(new Error(JSON.stringify(message.error)))
      else slot.resolve(message.result)
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
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  async eval(expression, timeoutMs = 30_000) {
    const result = await Promise.race([
      this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('页面无响应')), timeoutMs)),
    ])
    if (result.exceptionDetails) throw new Error(`页面异常：${result.exceptionDetails.text}`)
    return result.result.value
  }
}

async function waitOk(url, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
    } catch {
      // 还没起来
    }
    await sleep(150)
  }
  throw new Error(`等待 ${url} 超时`)
}

/** 打开页面并把状态栏的变化录成时间线，直到亮绿灯或超时。 */
async function runScenario({ scenario, port, debugPort, dropAuth }) {
  const profile = path.join(OUT, `edge-${scenario}`)
  rmSync(profile, { recursive: true, force: true })
  const { server, stats } = await startMock(port, { scenario, dropAuth })
  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--window-size=1500,950',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let cdp
  const out = { scenario, timeline: [], stats: null, ok: false }
  try {
    await waitOk(`http://127.0.0.1:${debugPort}/json/version`)
    const targets = await (await waitOk(`http://127.0.0.1:${debugPort}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page')
    cdp = await Cdp.connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` })

    // 等状态栏出现（页面挂载完成）
    let mounted = false
    for (let i = 0; i < 100 && !mounted; i += 1) {
      mounted = await cdp.eval(`!!document.querySelector('.status-text')`).catch(() => false)
      if (!mounted) await sleep(100)
    }
    if (!mounted) throw new Error('页面没渲染出状态栏')

    out.timeline = await cdp.eval(
      `(async () => {
        const seen = []
        const started = performance.now()
        let last = null
        while (performance.now() - started < 22000) {
          const text = document.querySelector('.status-text')?.textContent || ''
          const ok = !!document.querySelector('.status-dot.ok')
          const key = text + '|' + ok
          if (key !== last) {
            seen.push({ t: Math.round(performance.now() - started), text, ok })
            last = key
          }
          if (ok) break
          await new Promise((r) => setTimeout(r, 80))
        }
        return seen
      })()`,
      40_000,
    )
    out.stats = { ...stats }
  } finally {
    try {
      await cdp?.send('Browser.close')
    } catch {
      // 关不掉就杀
    }
    edge.kill()
    server.close()
  }

  const final = out.timeline.at(-1)
  out.ok = Boolean(final?.ok)
  return out
}

async function main() {
  if (!existsSync(path.join(DIST, 'index.html'))) {
    throw new Error('dist/index.html 不存在，先跑 npm run build')
  }
  mkdirSync(OUT, { recursive: true })

  const results = []
  results.push(
    await runScenario({ scenario: 'backend-down', port: 5281, debugPort: 9341, dropAuth: 0 }),
  )
  results.push(await runScenario({ scenario: 'auth-drop', port: 5282, debugPort: 9343, dropAuth: 2 }))

  let failed = false
  for (const result of results) {
    const last = result.timeline.at(-1)
    console.log(`\n=== ${result.scenario} ===`)
    for (const item of result.timeline) {
      console.log(`  +${String(item.t).padStart(5)}ms  ${item.ok ? '🟢' : '🔴'} ${item.text}`)
    }
    console.log('  stats:', JSON.stringify(result.stats))
    if (!last?.ok) {
      failed = true
      console.log('  ❌ 没有自动连上')
    } else if (result.scenario === 'backend-down' && (result.stats?.reconnects ?? 0) < 1) {
      failed = true
      console.log('  ❌ 连上了，但不是靠自动重连（/api/reconnect 没被调用）')
    } else if (result.scenario === 'auth-drop' && (result.stats?.authSent ?? 0) < 3) {
      failed = true
      console.log('  ❌ 握手没有自动重试（oc:auth 只发了 %d 次）', result.stats?.authSent ?? 0)
    } else {
      console.log('  ✅ 未连接后自动恢复成功')
    }
  }
  if (failed) process.exit(1)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
