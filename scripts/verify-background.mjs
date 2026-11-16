// 验收：输入区的「后台」按钮 + Ctrl+B。
// dev 模式（先起 vite 127.0.0.1:5273）：
//   node scripts/verify-background.mjs 9233 [root]
const port = Number(process.argv[2] || 9233)
const root = process.argv[3] || 'F:\\opencode\\workbench'
const DEV = process.env.OCW_BASE || 'http://127.0.0.1:5273'

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
// 只认 dev 页面：兜底选「任意一个标签页」会把开发者正在用的浏览器导航走、还会改它的
// localStorage，验收脚本不该有这种副作用。
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

// --- 1. 打开 dev 页面并落好项目根 ---
await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: DEV + '/' })
await sleep(1500)
await evaluate(`localStorage.setItem('oc-workbench:root', ${JSON.stringify(root)}); true`)
await send('Page.reload')
await sleep(2500)

const ready = await waitFor(`!!document.querySelector('.chat-input')`, 30000)
check('页面加载出聊天输入框', !!ready)

// --- 2. 先切到一个全新会话（idle），再断言没有「后台」按钮 ---
await evaluate(`document.querySelector('.chat-new')?.click(); true`)
await sleep(1500)
const idleGhost = await evaluate(`!!document.querySelector('.chat-send.ghost')`)
check('idle 时不渲染「后台」按钮', idleGhost === false, `ghost=${idleGhost}`)

// --- 3. 发一条消息把会话切到 running（不等模型，发送瞬间就 start） ---
const sendPrompt = (text) => evaluate(`(() => {
  const ta = document.querySelector('.chat-input')
  if (!ta) return 'no-input'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, ${JSON.stringify(text)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  const btn = document.querySelector('.chat-send')
  if (!btn) return 'no-send'
  btn.click()
  return 'ok'
})()`)

const sent = await sendPrompt('验收后台按钮，收到后只需回复 OK')
check('能发出消息', sent === 'ok', String(sent))

const running = await waitFor(`!!document.querySelector('.chat-send.ghost')`, 20000, 200)
check('running 时出现「后台」按钮', !!running)

const label = await evaluate(`document.querySelector('.chat-send.ghost')?.textContent?.trim() || ''`)
check('按钮文案是「后台」', label === '后台', `label=${JSON.stringify(label)}`)

// --- 4. 点按钮 → 成功提示 ---
await evaluate(`document.querySelector('.chat-notice-close')?.click(); true`)
await evaluate(`document.querySelector('.chat-send.ghost')?.click(); true`)
const notice = await waitFor(
  `(() => { const n = document.querySelector('.chat-notice.ok .chat-notice-text'); return n ? n.textContent : '' })()`,
  15000,
  200,
)
check('点击后出现成功提示', !!notice, String(notice || ''))
check('提示文案说明了「后台」', typeof notice === 'string' && notice.includes('后台'), String(notice || ''))

// --- 4.5 手机窄屏：多一个按钮不能把输入框挤没 ---
for (const width of [390, 320]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true })
  await sleep(700)
  // 模型很快回完时按钮会消失；先确保还在 running，才能量到「两个按钮」的真实布局
  if (!(await evaluate(`!!document.querySelector('.chat-send.ghost')`))) {
    await sendPrompt('窄屏布局验收，回 OK')
    await waitFor(`!!document.querySelector('.chat-send.ghost')`, 20000, 200)
    await sleep(300)
  }
  check(`手机 ${width}px 测量时按钮确实在`, await evaluate(`!!document.querySelector('.chat-send.ghost')`))
  const m = await evaluate(`(() => {
    const row = document.querySelector('.chat-input-row')
    const ta = document.querySelector('.chat-input')
    if (!row || !ta) return null
    return {
      rowScroll: row.scrollWidth,
      rowClient: row.clientWidth,
      taW: Math.round(ta.getBoundingClientRect().width),
      ghost: !!document.querySelector('.chat-send.ghost'),
    }
  })()`)
  check(`手机 ${width}px 输入行不横向溢出`, !!m && m.rowScroll <= m.rowClient + 1, JSON.stringify(m))
  check(`手机 ${width}px 输入框仍有可用宽度(${m ? m.taW : '-'}px)`, !!m && m.taW >= 80, JSON.stringify(m))
  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(400)
}

// --- 5. Ctrl+B：焦点在 body 上应该触发 ---
// 注意：这里用合成 KeyboardEvent，只能证明「页面的 handler 逻辑对不对」。
// 真实按键从 OS/WebView2 到页面这一层（会不会被宿主吞掉）不在这条断言的覆盖范围内，
// 要验真按键得在 exe 里用真实的按键注入或人肉按。
// 模型可能已经回完了（很快）：先确认还在 running，不在就再发一条切回去
if (!(await evaluate(`!!document.querySelector('.chat-send.ghost')`))) {
  await sendPrompt('再跑一条，验证 Ctrl+B')
  await waitFor(`!!document.querySelector('.chat-send.ghost')`, 20000, 200)
}
await evaluate(`document.querySelector('.chat-notice-close')?.click(); true`)
await sleep(300)
const stillRunning = await evaluate(`!!document.querySelector('.chat-send.ghost')`)
const viaHotkey = await evaluate(`(() => {
  document.body.focus?.()
  const ev = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })
  document.body.dispatchEvent(ev)
  return ev.defaultPrevented
})()`)
const notice2 = await waitFor(
  `(() => { const n = document.querySelector('.chat-notice.ok .chat-notice-text'); return n ? n.textContent : '' })()`,
  15000,
  200,
)
check('焦点在 body 时 Ctrl+B 被接管（preventDefault）', viaHotkey === true, `prevented=${viaHotkey}, running=${stillRunning}`)
check('Ctrl+B 同样给出提示', !!notice2, String(notice2 || ''))

// --- 6. 焦点在输入框里时，Ctrl+B 不该被我们接管 ---
await evaluate(`document.querySelector('.chat-notice-close')?.click(); true`)
await sleep(200)
const inTextarea = await evaluate(`(() => {
  const ta = document.querySelector('.chat-input')
  if (!ta) return 'no-input'
  ta.focus()
  const ev = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })
  ta.dispatchEvent(ev)
  return { prevented: ev.defaultPrevented, target: ev.target.tagName }
})()`)
await sleep(800)
const notice3 = await evaluate(
  `(() => { const n = document.querySelector('.chat-notice.ok .chat-notice-text'); return n ? n.textContent : '' })()`,
)
check(
  '输入框里的 Ctrl+B 不被接管',
  inTextarea && inTextarea.prevented === false && (notice3 === '' || notice3 === null),
  JSON.stringify({ inTextarea, notice3 }),
)

// --- 7. 收尾：中断这条验收会话的生成 ---
await evaluate(`document.querySelector('.chat-send.stop')?.click(); true`)
await sleep(1200)

const failed = report.filter((r) => !r.ok)
console.log(`\n${report.length - failed.length}/${report.length} PASS`)
process.exit(failed.length ? 1 : 0)
