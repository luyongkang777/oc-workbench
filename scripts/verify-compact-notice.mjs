/**
 * 压缩上下文提示条的端到端验收。
 *
 * 流程：起 mock 后端（复现 436k → 2.5k 的压缩场景）→ 起 vite dev（走
 * OC_WORKBENCH_TARGET 直连 mock）→ headless Edge 打开页面 → 真的点开用量浮层、
 * 点「压缩上下文」→ 抓两个时刻的 DOM 和截图 → 关掉所有子进程。
 *
 * 不用真 opencode：pair 走 IPC、脚本里没有稳定凭据；压缩本身也是分钟级，
 * 而这里要验的只是「点了有没有提示、完了有没有结果」。
 *
 * 用法：node scripts/verify-compact-notice.mjs
 * 产物：.tmp/compact-running.png / .tmp/compact-done.png
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WORKBENCH = join(HERE, '..')
const OUT_DIR = join(WORKBENCH, '.tmp')
const PROFILE = join(OUT_DIR, 'edge-profile-compact')
const ROOT = 'F:\\opencode\\workbench'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const MOCK_PORT = 28999
const VITE_PORT = 5273
const CDP_PORT = 9333
/** mock 压缩耗时：够长到能截到「进行中」，又不至于把验收拖成几分钟。 */
const COMPACT_MS = 2500

mkdirSync(OUT_DIR, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------------------------------------------------------- mock 后端 */

const MODEL = {
  id: 'mock-model',
  providerID: 'mock',
  name: 'Mock 1M',
  limit: { context: 1_000_000, output: 32_000 },
}

const SESSION = {
  id: 'ses_mock_compact',
  title: '压缩提示验收',
  location: { directory: ROOT },
  metadata: { source: 'oc-workbench' },
  model: { id: MODEL.id, providerID: MODEL.providerID },
  time: { created: Date.now() - 60_000, updated: Date.now() },
}

/** 压缩前的历史：最新一条 assistant 带上 436k 上下文，正好对上截图里的 436.0K。 */
const BEFORE = [
  {
    id: 'msg_a1',
    type: 'assistant',
    time: { created: Date.now() - 30_000, completed: Date.now() - 20_000 },
    model: { id: MODEL.id, providerID: MODEL.providerID },
    tokens: { input: 400_000, output: 10_000, cache: { read: 26_000 } },
    content: [
      {
        type: 'text',
        text: '这是压缩前的长回复。它带上了很多历史，上下文占用已经到了 436k，继续聊下去迟早撑满窗口。',
      },
    ],
  },
  {
    id: 'msg_u1',
    type: 'user',
    time: { created: Date.now() - 40_000 },
    content: [{ type: 'text', text: '把之前那些都过一遍，然后继续。' }],
  },
]

/**
 * 压缩后：历史被重写成一条 `type: 'compaction'` 消息，摘要正文在 `summary` 字段
 * （`content` 为空），tokens 记的是「生成摘要那次调用」——input/cache 还是压缩前
 * 那一大坨 461k，只有 output 是摘要本身。这正是「461k → 461k」的来源。
 */
const AFTER = [
  {
    id: 'msg_compaction',
    type: 'compaction',
    summary:
      '## Objective\n\n- 压缩前的目标与当前阶段（摘要已重写历史）。\n\n## Requirements\n\n- 中文交流，先说结论再说原因。',
    time: { created: Date.now(), completed: Date.now() },
    tokens: { input: 427_710, output: 2_500, cache: { read: 34_816 } },
    content: [],
  },
  {
    id: 'msg_c1',
    type: 'user',
    text: '压缩摘要',
    time: { created: Date.now() },
  },
]

let compacted = false
let compactCalls = 0

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

const mock = createServer(async (req, res) => {
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
    res.write(': mock connected\n\n')
    return // 保持连接：前端断流会每 2 秒重连，产生噪声
  }

  if (path === '/api/model') return sendJson(res, 200, { data: [MODEL] })
  if (path === '/api/model/default') return sendJson(res, 200, { data: MODEL })
  if (path === '/api/agent') return sendJson(res, 200, { data: [{ id: 'build', name: 'build' }] })
  if (path === '/api/command') return sendJson(res, 200, { data: [] })

  if (path === '/api/session') {
    if (method === 'POST') return sendJson(res, 200, { data: SESSION })
    return sendJson(res, 200, { data: [SESSION], cursor: {} })
  }

  const match = /^\/api\/session\/([^/]+)(?:\/(.+))?$/.exec(path)
  if (match) {
    const id = decodeURIComponent(match[1])
    const sub = match[2] ?? ''
    if (id !== SESSION.id) return sendJson(res, 404, { error: `unknown session ${id}` })
    if (!sub) return sendJson(res, 200, { data: SESSION })
    if (sub === 'message') {
      return sendJson(res, 200, { data: compacted ? AFTER : BEFORE })
    }
    if (sub === 'form') return sendJson(res, 200, { data: [] })
    if (sub === 'compact' && method === 'POST') {
      compactCalls += 1
      await sleep(COMPACT_MS)
      compacted = true
      return sendJson(res, 200, { ok: true })
    }
    return sendJson(res, 200, { data: {} })
  }

  sendJson(res, 404, { error: `mock: no route ${method} ${path}` })
})

/* --------------------------------------------------------------- CDP 客户端 */

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    // 页面里的异常/控制台消息：就绪检查超时时靠它说明到底是白屏还是报错
    this.events = []
    ws.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (!msg.id) {
        if (this.events.length < 100) this.events.push(msg)
        return
      }
      const slot = this.pending.get(msg.id)
      if (!slot) return
      this.pending.delete(msg.id)
      if (msg.error) slot.reject(new Error(`${msg.error.message} (${msg.error.code})`))
      else slot.resolve(msg.result)
    })
  }

  /** 页面里抛出的未捕获异常（一句话一条）。 */
  pageErrors() {
    return this.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => {
        const detail = e.params?.exceptionDetails
        return detail?.exception?.description ?? detail?.text ?? 'unknown'
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
    })
    if (result.exceptionDetails) {
      throw new Error(`页面执行失败：${result.exceptionDetails.text}`)
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

  async shot(file, selector) {
    let clip
    if (selector) {
      const rect = await this.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
      )
      if (rect) clip = { ...rect, scale: 1 }
    }
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      ...(clip ? { clip } : {}),
    })
    writeFileSync(file, Buffer.from(data, 'base64'))
  }
}

async function fetchOk(url, options, timeoutMs = 2000) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
    return res
  } catch {
    return null
  }
}

async function waitHttp(url, timeoutMs, options) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetchOk(url, options)
    if (res?.ok) return res
    await sleep(200)
  }
  throw new Error(`服务没起来：${url}`)
}

/* --------------------------------------------------------------------- 主流程 */

const children = []
function track(child, name) {
  children.push({ child, name })
  child.on('exit', (code, signal) => {
    if (code && code !== 0 && !signal) console.warn(`[${name}] 退出码 ${code}`)
  })
  return child
}

let exitCode = 0
try {
  if (!existsSync(EDGE)) throw new Error(`找不到 Edge：${EDGE}`)

  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve))
  console.log(`[mock] http://127.0.0.1:${MOCK_PORT}（压缩耗时 ${COMPACT_MS}ms）`)

  const vite = track(
    spawn(process.execPath, [join(WORKBENCH, 'node_modules', 'vite', 'bin', 'vite.js')], {
      cwd: WORKBENCH,
      env: { ...process.env, OC_WORKBENCH_TARGET: `http://127.0.0.1:${MOCK_PORT}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    'vite',
  )
  vite.stdout.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) console.log(`[vite] ${text.split('\n').slice(-1)[0]}`)
  })
  await waitHttp(`http://127.0.0.1:${VITE_PORT}/`, 40_000)
  console.log(`[vite] http://127.0.0.1:${VITE_PORT}/ 就绪`)

  rmSync(PROFILE, { recursive: true, force: true })
  const edge = track(
    spawn(
      EDGE,
      [
        '--headless=new',
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${PROFILE}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-features=msEdgeSidebarV2',
        '--hide-scrollbars',
        '--window-size=1500,980',
        'about:blank',
      ],
      { stdio: 'ignore' },
    ),
    'edge',
  )
  await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 30_000)
  console.log('[edge] CDP 就绪')

  const pageUrl = `http://127.0.0.1:${VITE_PORT}/`
  const created = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(pageUrl)}`,
    { method: 'PUT' },
  )
  if (!created.ok) throw new Error(`建标签页失败：${created.status} ${await created.text()}`)
  const target = await created.json()

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连不上')), { once: true })
  })
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  // 1. 等聊天区真的就绪：百分比算出来了才算会话和消息都到手。
  //    （只等元素存在会在「—」占位时就通过，那时点压缩只会得到「当前没有会话」）
  const ready = `!!document.querySelector('.chat-context-chip') && /\\d+%/.test(document.querySelector('.chat-context-text')?.textContent ?? '')`
  try {
    await cdp.waitFor(ready, 25_000, '聊天区就绪（上下文百分比已算出）')
  } catch {
    // dev server 刚起来时 watcher 可能补发上一条 HMR，把页面整页刷掉一次。
    // 重载再等一轮；真出错（模块编译失败）第二轮同样会失败，不会把问题盖住。
    console.warn('[ui] 首次就绪超时，重新加载页面再试')
    await cdp.send('Page.reload', { ignoreCache: true })
    try {
      await cdp.waitFor(ready, 25_000, '聊天区就绪（重载后）')
    } catch (err) {
      const snapshot = await cdp
        .evaluate(
          `(() => ({
            title: document.title,
            root: (document.querySelector('#root')?.innerHTML ?? '').length,
            text: (document.body.innerText ?? '').slice(0, 300),
          }))()`,
        )
        .catch(() => null)
      console.error(`[ui] 页面快照：${JSON.stringify(snapshot)}`)
      console.error(`[ui] 页面异常：${JSON.stringify(cdp.pageErrors())}`)
      throw err
    }
  }
  const percentBefore = await cdp.evaluate(
    `document.querySelector('.chat-context-text')?.textContent ?? ''`,
  )
  console.log(`[ui] 压缩前上下文占用：${percentBefore}`)

  // 2. 点开用量浮层，确认「压缩上下文」按钮在
  await cdp.evaluate(`document.querySelector('.chat-context-chip').click()`)
  await cdp.waitFor(
    `!![...document.querySelectorAll('.chat-context-action')].find(b => b.textContent.includes('压缩上下文'))`,
    5_000,
    '浮层里的压缩按钮',
  )

  // 3. 点压缩
  const clicked = await cdp.evaluate(
    `(() => { const b = [...document.querySelectorAll('.chat-context-action')].find(b => b.textContent.includes('压缩上下文'));
      if (!b) return 'no-button'; b.click(); return b.textContent; })()`,
  )
  console.log(`[ui] 点击按钮：${clicked}`)

  // 4. 进行中提示：必须是 info 状态 + 带当前规模
  const diagNow = async () =>
    cdp.evaluate(
      `(() => ({
        warn: document.querySelector('.chat-warn')?.textContent ?? null,
        placeholder: document.querySelector('.chat-placeholder')?.textContent ?? null,
        notice: document.querySelector('.chat-notice')?.className ?? null,
        noticeText: document.querySelector('.chat-notice-text')?.textContent ?? null,
        header: (document.querySelector('.chat-header')?.textContent ?? '').slice(0, 160),
        turns: document.querySelectorAll('.chat-turn').length,
        chats: document.querySelectorAll('.chat').length,
        chips: document.querySelectorAll('.chat-context-chip').length,
        actions: document.querySelectorAll('.chat-context-action').length,
        headerCount: document.querySelectorAll('.chat-header').length,
      }))()`,
    )
  try {
    await cdp.waitFor(`!!document.querySelector('.chat-notice.info')`, 6_000, '压缩中提示条')
  } catch (err) {
    console.error(`[ui] 诊断：${JSON.stringify(await diagNow())}`)
    throw err
  }
  const running = await cdp.evaluate(
    `(() => { const n = document.querySelector('.chat-notice');
      return n ? { cls: n.className, text: n.querySelector('.chat-notice-text')?.textContent ?? '',
        detail: n.querySelector('.chat-notice-detail')?.textContent ?? '' } : null; })()`,
  )
  const meter = await cdp.evaluate(
    `document.querySelector('.chat-context-action')?.textContent ?? ''`,
  )
  console.log(`[ui] 进行中提示：${JSON.stringify(running)}`)
  console.log(`[ui] 浮层按钮文案：${meter}`)
  await cdp.shot(join(OUT_DIR, 'compact-running.png'), '.chat')

  // 5. 完成提示：ok 状态 + 压缩前后数字 + 耗时
  await cdp.waitFor(`!!document.querySelector('.chat-notice.ok')`, 25_000, '压缩完成提示条')
  const done = await cdp.evaluate(
    `(() => { const n = document.querySelector('.chat-notice');
      return n ? { cls: n.className, text: n.querySelector('.chat-notice-text')?.textContent ?? '',
        detail: n.querySelector('.chat-notice-detail')?.textContent ?? '' } : null; })()`,
  )
  console.log(`[ui] 完成提示：${JSON.stringify(done)}`)
  await cdp.shot(join(OUT_DIR, 'compact-done.png'), '.chat')

  // 5.4 压缩摘要：历史被重写的那段正文必须在聊天区里看得到
  await cdp.waitFor(`!!document.querySelector('.chat-summary')`, 8_000, '压缩摘要块')
  const summaryBlock = await cdp.evaluate(
    `(() => { const el = document.querySelector('.chat-summary');
      return el ? { cls: el.className, text: (el.textContent ?? '').slice(0, 200) } : null; })()`,
  )
  console.log(`[ui] 压缩摘要：${JSON.stringify(summaryBlock?.text ?? null)}`)
  await cdp.shot(join(OUT_DIR, 'compact-summary.png'), '.chat')

  // 5.5 压缩记录：历史被重写后，会话里还能回看这次是哪一轮
  await cdp.waitFor(`!!document.querySelector('.chat-compact-log')`, 5_000, '压缩记录卡片')
  const logCollapsed = await cdp.evaluate(
    `(() => { const el = document.querySelector('.chat-compact-log');
      return el ? { cls: el.className, text: el.textContent ?? '' } : null; })()`,
  )
  await cdp.evaluate(`document.querySelector('.chat-compact-log-head')?.click()`)
  await cdp.waitFor(`!!document.querySelector('.chat-compact-log-row')`, 3_000, '展开后的记录行')
  const logOpen = await cdp.evaluate(
    `(() => { const el = document.querySelector('.chat-compact-log');
      if (!el) return null;
      return { cls: el.className,
        rows: [...el.querySelectorAll('.chat-compact-log-row')].map((r) => r.textContent ?? '') }; })()`,
  )
  console.log(`[ui] 压缩记录（收起）：${JSON.stringify(logCollapsed?.text ?? null)}`)
  console.log(`[ui] 压缩记录（展开）：${JSON.stringify(logOpen)}`)
  await cdp.shot(join(OUT_DIR, 'compact-log.png'), '.chat')

  // 5.6 刷新后记录还在：这是「往后翻历史还能看到」的前提
  await cdp.send('Page.reload', { ignoreCache: true })
  await cdp.waitFor(
    `!!document.querySelector('.chat-context-chip') && /\\d+%/.test(document.querySelector('.chat-context-text')?.textContent ?? '')`,
    25_000,
    '刷新后的聊天区',
  )
  await cdp.waitFor(`!!document.querySelector('.chat-compact-log')`, 5_000, '刷新后的压缩记录')
  const logAfterReload = await cdp.evaluate(
    `document.querySelector('.chat-compact-log')?.textContent ?? null`,
  )
  console.log(`[ui] 刷新后记录：${JSON.stringify(logAfterReload)}`)
  await cdp.shot(join(OUT_DIR, 'compact-log-reload.png'), '.chat')

  // 6. 断言
  const failures = []
  if (!running?.text?.includes('正在压缩上下文')) failures.push('进行中提示文案不对')
  if (!running?.cls?.includes('info')) failures.push('进行中没有用 info 状态')
  if (!done?.text?.includes('已压缩')) failures.push('完成提示里没有「已压缩」')
  if (!done?.text?.includes('436k')) failures.push('完成提示里没有压缩前的 436k')
  if (!done?.text?.includes('2.5k')) failures.push('完成提示里没有压缩后的 2.5k')
  if (!done?.text?.includes('s）')) failures.push('完成提示里没有耗时')
  if (!logCollapsed?.text?.includes('压缩记录')) failures.push('没有压缩记录卡片')
  if (!logCollapsed?.text?.includes('436k')) failures.push('记录摘要里没有压缩前的 436k')
  if (logOpen?.rows?.length !== 1) failures.push(`展开后记录应为 1 行，实际 ${logOpen?.rows?.length ?? 0}`)
  if (!logOpen?.rows?.[0]?.includes('2.5k')) failures.push('记录行里没有压缩后的 2.5k')
  if (!logAfterReload?.includes('压缩记录')) failures.push('刷新页面后压缩记录丢了')
  if (!logAfterReload?.includes('436k')) failures.push('刷新后记录里没有压缩前的 436k')
  if (!summaryBlock?.text?.includes('Objective')) failures.push('聊天区没有显示压缩摘要正文')
  if (compactCalls !== 1) failures.push(`压缩接口被调用了 ${compactCalls} 次（应为 1）`)

  if (failures.length > 0) {
    exitCode = 1
    console.error(`\n✗ 验收失败：\n- ${failures.join('\n- ')}`)
  } else {
    console.log('\n✓ 压缩提示验收通过')
    console.log(`  进行中：${running.text}${running.detail ? `（${running.detail}）` : ''}`)
    console.log(`  完成：${done.text}${done.detail ? `（${done.detail}）` : ''}`)
    console.log(`  摘要：${(summaryBlock.text ?? '').replace(/\s+/g, ' ').slice(0, 80)}`)
    console.log(`  记录：${logCollapsed.text}`)
    console.log(`  刷新后：${logAfterReload}`)
    console.log(`  截图：${join(OUT_DIR, 'compact-running.png')}`)
    console.log(`        ${join(OUT_DIR, 'compact-done.png')}`)
    console.log(`        ${join(OUT_DIR, 'compact-summary.png')}`)
    console.log(`        ${join(OUT_DIR, 'compact-log.png')}`)
    console.log(`        ${join(OUT_DIR, 'compact-log-reload.png')}`)
  }

  ws.close()
  try {
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${target.id}`)
  } catch {
    // 关不关都随 edge 一起退出
  }
  edge.kill()
} catch (err) {
  exitCode = 1
  console.error(`✗ 验收中断：${err.message}`)
} finally {
  for (const { child } of children) {
    try {
      child.kill()
    } catch {
      // ignore
    }
  }
  mock.close()
  // 子进程在 Windows 上要一点时间收尾，别让端口占着
  await sleep(600)
  rmSync(PROFILE, { recursive: true, force: true })
  process.exit(exitCode)
}
