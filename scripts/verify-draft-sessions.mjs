// 验证「同一个标签内切换会话」时草稿按会话分开：A 会话打的字不会跑到 B 会话，
// 切回 A 还在。
// 用法：node scripts/verify-draft-sessions.mjs [cdpPort]
// 需要至少两条会话；不足就跳过（退出码 0）。
const port = Number(process.argv[2] || 9233)

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('没找到页面目标')

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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || '脚本失败')
  return result.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = []
const check = (name, ok, detail = '') => {
  report.push({ ok })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

// 打开会话下拉
const opened = await evaluate(`(async () => {
  const toggle = document.querySelector('.chat-session-toggle')
  if (!toggle) return { error: '没有会话下拉' }
  toggle.click()
  await new Promise((r) => setTimeout(r, 500))
  return {
    items: Array.from(document.querySelectorAll('.chat-session-item')).map((el) => ({
      title: (el.querySelector('.chat-session-title')?.textContent || '').trim(),
      active: el.classList.contains('active'),
    })),
  }
})()`)
if (opened.error || !opened.items || opened.items.length < 2) {
  process.stdout.write(`会话数量不足（${JSON.stringify(opened)}），跳过\n`)
  ws.close()
  process.exit(0)
}

const MARK = '会话草稿-' + Date.now().toString(36)
const activeIndex = opened.items.findIndex((item) => item.active)
const otherIndex = activeIndex === 0 ? 1 : 0

// 在当前会话打字
await evaluate(`(async () => {
  const input = document.querySelector('.chat-input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(MARK)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(800)

const clickItem = (index) => `(async () => {
  const toggle = document.querySelector('.chat-session-toggle')
  if (!document.querySelector('.chat-session-item')) toggle?.click()
  await new Promise((r) => setTimeout(r, 400))
  const items = Array.from(document.querySelectorAll('.chat-session-item'))
  const target = items[${index}]
  target?.querySelector('.chat-session-main')?.click() || target?.click()
  await new Promise((r) => setTimeout(r, 1800))
  return document.querySelector('.chat-input')?.value ?? null
})()`

const inOther = await evaluate(clickItem(otherIndex))
check('切到另一个会话：输入框没带过去当前会话的字', inOther !== MARK, `value=${JSON.stringify(inOther)}`)

const back = await evaluate(clickItem(activeIndex))
check('切回原会话：草稿还在', back === MARK, `value=${JSON.stringify(back)}`)

// 清理
await evaluate(`(async () => {
  const input = document.querySelector('.chat-input')
  if (!input) return
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})()`)

const failed = report.filter((item) => !item.ok)
process.stdout.write(`\n${report.length - failed.length}/${report.length} 通过\n`)
ws.close()
process.exit(failed.length === 0 ? 0 : 1)
