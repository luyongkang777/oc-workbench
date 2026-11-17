// 验收：终端停靠面板（编辑区底部，Cursor 式）。
// 前置：dev 已起在 127.0.0.1:5273，且有一个 Edge/Chrome 页面开着 dev 页。
//   node scripts/verify-shell-panel.mjs 9233 [root]
const port = Number(process.argv[2] || 9233)
const root = process.argv[3] || 'F:\\opencode\\workbench'
const DEV = process.env.OCW_BASE || 'http://127.0.0.1:5273'
const PROBE = 'ping -n 40 127.0.0.1'
const LOC = `location%5Bdirectory%5D=${encodeURIComponent(root)}`

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('5273'))
if (!page) throw new Error('没找到 127.0.0.1:5273 的 dev 页面：先起 vite dev，再打开一个标签页')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
})
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})

function send(method, params = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || '脚本执行失败')
  }
  return result.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = []
function check(name, ok, detail = '') {
  report.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}
async function waitFor(expression, timeoutMs = 20000, step = 300) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(expression)
    if (value) return value
    await sleep(step)
  }
  return null
}

// --- 1. 进 dev 页、设好项目根、确保终端打开 ---
await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: DEV + '/' })
await sleep(1500)
await evaluate(`localStorage.setItem('oc-workbench:root', ${JSON.stringify(root)}); localStorage.setItem('oc-workbench:term-open', '1'); true`)
await send('Page.reload')
await sleep(2500)

check('终端面板渲染出来', Boolean(await waitFor(`!!document.querySelector('.terminal.docked')`, 30000)))

const placed = await evaluate(`(() => {
  const term = document.querySelector('.terminal')
  const pane = document.querySelector('.editor-pane')
  if (!term || !pane) return null
  const inPane = term.parentElement === pane
  return {
    inPane,
    termW: Math.round(term.getBoundingClientRect().width),
    paneW: Math.round(pane.getBoundingClientRect().width),
    termH: Math.round(term.getBoundingClientRect().height),
  }
})()`)
check('终端挂在编辑区里（不是全宽底部条）', !!placed && placed.inPane === true, JSON.stringify(placed))
check('外壳宽度等于编辑区宽度', !!placed && Math.abs(placed.termW - placed.paneW) <= 1, JSON.stringify(placed))

// --- 2. 顶部统计 ---
const stats = await evaluate(`(() => {
  const items = [...document.querySelectorAll('.terminal-stat')]
  return items.map((el) => ({ text: el.textContent.trim(), title: el.getAttribute('title') || '' }))
})()`)
check('头部有智能体 / Shell 两个计数', Array.isArray(stats) && stats.length === 2, JSON.stringify(stats))
check(
  '两个计数分别说明智能体与 Shell',
  Array.isArray(stats) && stats.some((s) => s.title.includes('智能体')) && stats.some((s) => s.title.includes('命令')),
  JSON.stringify(stats),
)

// --- 3. 顶栏按钮开关 ---
const toggle = await evaluate(`(() => {
  const btn = document.querySelector('[aria-label="终端面板开关"]')
  if (!btn) return 'no-btn'
  btn.click()
  return 'ok'
})()`)
check('顶栏有终端按钮', toggle === 'ok', String(toggle))
await sleep(500)
check('点顶栏按钮可以关掉终端', (await evaluate(`!document.querySelector('.terminal')`)) === true)

await evaluate(`document.querySelector('[aria-label="终端面板开关"]')?.click(); true`)
await sleep(500)
check('再点一次可以打开', (await evaluate(`!!document.querySelector('.terminal')`)) === true)

// --- 4. 头部 × 关闭 ---
await evaluate(`document.querySelector('.terminal-close')?.click(); true`)
await sleep(400)
check('头部 × 能关闭面板', (await evaluate(`!document.querySelector('.terminal')`)) === true)
await evaluate(`document.querySelector('[aria-label="终端面板开关"]')?.click(); true`)
await sleep(600)

// --- 5. 拖拽高度 + 双击复位 ---
const drag = await evaluate(`(() => {
  const bar = document.querySelector('.row-resizer')
  const term = document.querySelector('.terminal')
  if (!bar || !term) return null
  const before = Math.round(term.getBoundingClientRect().height)
  const rect = bar.getBoundingClientRect()
  const base = { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: rect.left + 8, clientY: rect.top + 3 }
  bar.dispatchEvent(new PointerEvent('pointerdown', base))
  window.dispatchEvent(new PointerEvent('pointermove', { ...base, clientY: rect.top - 77 }))
  window.dispatchEvent(new PointerEvent('pointerup', base))
  return { before }
})()`)
await sleep(600)
const afterH = await evaluate(`Math.round(document.querySelector('.terminal')?.getBoundingClientRect().height ?? 0)`)
check('拖动上沿能改高度', !!drag && afterH > drag.before, JSON.stringify({ ...drag, afterH }))

const resetH = await evaluate(`(() => {
  const bar = document.querySelector('.row-resizer')
  if (!bar) return null
  const rect = bar.getBoundingClientRect()
  const base = { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: rect.left + 8, clientY: rect.top + 3 }
  bar.dispatchEvent(new PointerEvent('pointerdown', base))
  bar.dispatchEvent(new PointerEvent('pointerdown', base))
  return true
})()`)
await sleep(500)
const restored = await evaluate(`Math.round(document.querySelector('.terminal')?.getBoundingClientRect().height ?? 0)`)
check('双击复位到默认高度', resetH === true && Math.abs(restored - 240) <= 2, `h=${restored}`)

// --- 5.5 拖到上限后重开：拖动幅度不能被 max-height 带偏 ---
await evaluate(`localStorage.setItem('oc-workbench:term-h', '720'); localStorage.setItem('oc-workbench:term-open', '1'); true`)
await send('Page.reload')
await sleep(2500)
const reopened = await evaluate(`(() => {
  const bar = document.querySelector('.row-resizer')
  const term = document.querySelector('.terminal')
  if (!bar || !term) return null
  const before = Math.round(term.getBoundingClientRect().height)
  const rect = bar.getBoundingClientRect()
  const base = { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: rect.left + 8, clientY: rect.top + 3 }
  bar.dispatchEvent(new PointerEvent('pointerdown', base))
  window.dispatchEvent(new PointerEvent('pointermove', { ...base, clientY: rect.top + 103 }))
  window.dispatchEvent(new PointerEvent('pointerup', base))
  return { before }
})()`)
await sleep(600)
const shrunk = await evaluate(`Math.round(document.querySelector('.terminal')?.getBoundingClientRect().height ?? 0)`)
const delta = reopened ? reopened.before - shrunk : 0
check(
  '拖到上限后重开，向下拖 100px 高度确实减少约 100px',
  Boolean(reopened) && delta >= 70 && delta <= 140,
  JSON.stringify({ before: reopened?.before, after: shrunk, delta }),
)

// --- 6. Shell tab：列表 / 输出 / kill ---
await evaluate(`[...document.querySelectorAll('.terminal-tab')].find((el) => el.textContent.trim() === 'Shell')?.click(); true`)
await sleep(500)

const before = await evaluate(`[...document.querySelectorAll('.terminal-pane:not([hidden]) .shell-row')].map((el) => el.dataset.id)`)
const started = await evaluate(`(() => {
  ;(async () => {
    const id = document.querySelector('.terminal')?.dataset.session
      || (await (await fetch('/api/session?limit=1')).json())?.data?.[0]?.id
    if (!id) return
    await fetch('/api/session/' + encodeURIComponent(id) + '/shell', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: ${JSON.stringify(PROBE)} }),
    })
  })()
  return 'started'
})()`)
check('发起后台命令', started === 'started', String(started))

const probeID = await waitFor(`(() => {
  const rows = [...document.querySelectorAll('.terminal-pane:not([hidden]) .shell-row')].map((el) => el.dataset.id)
  return rows.find((id) => !${JSON.stringify(before)}.includes(id)) || ''
})()`, 25000, 400)
check('列表里出现刚跑的命令', Boolean(probeID), `id=${probeID}`)

if (!probeID) {
  console.log('\n没拿到探针命令 id，后续断言跳过')
  process.exit(1)
}

await evaluate(`document.querySelector('.terminal-pane:not([hidden]) .shell-row[data-id="${probeID}"]')?.click(); true`)
check('点开后有输出区', Boolean(await waitFor(`!!document.querySelector('.terminal-pane:not([hidden]) .shell-detail .shell-output')`, 10000, 300)))

await sleep(2500)
const output = await evaluate(`document.querySelector('.terminal-pane:not([hidden]) .shell-detail .shell-output')?.textContent || ''`)
check('输出区有命令真实输出', output.includes('Reply from') || /Pinging/i.test(output), output.slice(0, 60))

const killClicked = await evaluate(`(() => {
  const btn = document.querySelector('.terminal-pane:not([hidden]) .shell-kill')
  if (!btn) return 'no-btn'
  btn.click()
  return 'ok'
})()`)
check('运行中的命令有「终止」按钮', killClicked === 'ok', String(killClicked))

const gone = await waitFor(`(() => {
  const row = document.querySelector('.terminal-pane:not([hidden]) .shell-row[data-id="${probeID}"]')
  if (!row) return 'gone'
  return row.querySelector('.shell-dot.killed') ? 'killed' : ''
})()`, 20000, 400)
check('终止后从运行列表消失（或标为已终止）', Boolean(gone), String(gone || ''))

const serverGone = await waitFor(`(async () => {
  const res = await fetch('/api/shell?${LOC}')
  const json = await res.json()
  return !json.data.some((item) => item.id === ${JSON.stringify(probeID)})
})()`, 10000, 500)
check('服务端列表里也已移除', serverGone === true, String(serverGone))

// --- 7. 终端 tab：会话下起一个持久 PTY ---
const pty = await evaluate(`(async () => {
  const sid = document.querySelector('.terminal')?.dataset.session
    || (await (await fetch('/api/session?limit=1')).json())?.data?.[0]?.id
  if (!sid) return { ok: false, why: 'no-session' }
  const res = await fetch('/api/experimental/session/' + encodeURIComponent(sid) + '/terminal?${LOC}', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'cmd.exe', args: [], cwd: ${JSON.stringify(root)}, title: 'verify-pty', env: {}, size: { cols: 100, rows: 24 } }),
  })
  if (!res.ok) return { ok: false, status: res.status }
  const json = await res.json()
  return { ok: true, id: json.data?.id }
})()`)
check('能创建持久终端', pty?.ok === true, JSON.stringify(pty))

await evaluate(`[...document.querySelectorAll('.terminal-tab')].find((el) => el.textContent.trim() === '终端')?.click(); true`)
const ptyRow = pty?.id
  ? await waitFor(`!!document.querySelector('.shell-row[data-id="${pty.id}"]')`, 15000, 400)
  : null
check('终端 tab 列出该 PTY', Boolean(ptyRow))

if (ptyRow) {
  await evaluate(`document.querySelector('.shell-row[data-id="${pty.id}"]')?.click(); true`)
  check('点开终端后有快照区', Boolean(await waitFor(`!!document.querySelector('.terminal-pane:not([hidden]) .shell-detail .shell-output')`, 8000, 300)))
  await sleep(1200)
  const snapText = await evaluate(`document.querySelector('.terminal-pane:not([hidden]) .shell-detail .shell-output')?.textContent || ''`)
  check('快照区有终端内容', snapText.length > 0, snapText.slice(0, 40))

  await evaluate(`document.querySelector('.terminal-pane:not([hidden]) .shell-kill')?.click(); true`)
  const ptyGone = await waitFor(`!document.querySelector('.shell-row[data-id="${pty.id}"]')`, 15000, 400)
  check('移除后终端从列表消失', Boolean(ptyGone))
}

// --- 8. 窄屏：终端不横向溢出（手机是单列，先切到「编辑」栏） ---
for (const width of [390, 320]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true })
  await sleep(900)
  const switched = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.mobile-nav-btn')].find((el) => el.textContent.includes('编辑'))
    btn?.click()
    return !!btn
  })()`)
  await sleep(700)
  const m = await evaluate(`(() => {
    const head = document.querySelector('.terminal-head')
    const term = document.querySelector('.terminal')
    if (!head || !term) return null
    return {
      headScroll: head.scrollWidth,
      headClient: head.clientWidth,
      termScroll: term.scrollWidth,
      termClient: term.clientWidth,
    }
  })()`)
  check(`手机 ${width}px 终端在编辑栏可见`, Boolean(switched) && !!m && m.headClient > 0, JSON.stringify(m))
  check(`手机 ${width}px 头部不横向溢出`, !!m && m.headScroll <= m.headClient + 1, JSON.stringify(m))
  check(`手机 ${width}px 终端区域不横向溢出`, !!m && m.termScroll <= m.termClient + 1, JSON.stringify(m))
  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(300)
}

const failed = report.filter((r) => !r.ok)
console.log(`\n${report.length - failed.length}/${report.length} PASS`)
process.exit(failed.length ? 1 : 0)
