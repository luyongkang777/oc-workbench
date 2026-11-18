// 「会话在跑却显示没跑」自愈验收：
//   node scripts/verify-running-selfheal.mjs [cdpPort]
//
// 原理：老代码只在「自认为在跑」时轮询，一旦误判成空闲就彻底停手，
// 界面永久停在「没在跑」，只有切走再切回（重新挂载）才恢复。
// 所以这里直接数请求：空闲时窗口内必须**仍然**在查会话状态。
//
// 做法：hook window.fetch 记下所有 /api/session/<id> 单条查询，
// 等 9 秒（本地空闲间隔 2.5 秒 → 至少 3 次），再算次数。
const port = Number(process.argv[2] || 9223)

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = list.find((item) => item.type === 'page' && item.url.includes('127.0.0.1:5273'))
if (!page) {
  console.error('没找到工作台页面（需要先起 vite dev + Edge）')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (!msg.id || !pending.has(msg.id)) return
  const { resolve, reject } = pending.get(msg.id)
  pending.delete(msg.id)
  msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

for (let i = 0; i < 20; i += 1) {
  if (await evaluate(`Boolean(document.querySelector('.chat-session-toggle'))`)) break
  await sleep(500)
}

// 先挑一条**空闲**会话：正在生成的那条不适用（那时走的是快轮询）
const picked = await evaluate(`(async () => {
  const open = () => document.querySelector('.chat-session-toggle')?.click()
  if (!document.querySelector('.chat-session-item')) open()
  await new Promise((r) => setTimeout(r, 600))
  const items = Array.from(document.querySelectorAll('.chat-session-item'))
  // 灯是绿灯（idle）的才算空闲；灰灯=未知、黄灯=在跑
  const idleItem = items.find((el) => el.querySelector('.chat-session-light.idle'))
  const target = idleItem ?? items[0]
  target?.querySelector('.chat-session-main')?.click()
  await new Promise((r) => setTimeout(r, 1800))
  return {
    clicked: Boolean(target),
    idle: Boolean(idleItem),
    hasChat: Boolean(document.querySelector('.chat-input')),
    sendLabel: document.querySelector('.chat-send')?.textContent?.trim() ?? '',
  }
})()`)
check('找到并打开一条空闲会话', picked.clicked && picked.hasChat, `空闲条目=${picked.idle} 按钮=${picked.sendLabel}`)
check('打开后处于空闲态（按钮是「发送」）', picked.sendLabel.includes('发送'), picked.sendLabel)

// 开始计数：只数单条会话查询（/api/session/ses_xxx），不数会话列表
await evaluate(`(() => {
  window.__runningPoll = []
  const raw = window.fetch
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url ?? '')
    if (/\\/api\\/session\\/ses_[^/?]+$/.test(url)) window.__runningPoll.push(Date.now())
    return raw.apply(this, arguments)
  }
  return true
})()`)

// 9 秒：本地空闲间隔 2.5 秒 → 期望 3~4 次
await sleep(9500)

const counts = await evaluate(`({ count: (window.__runningPoll ?? []).length })`)
check(
  '空闲时仍在轮询会话状态（自愈的关键）',
  counts.count >= 2,
  `9.5 秒内 ${counts.count} 次（老实现这里是 0 次）`,
)

ws.close()
const failed = report.filter((item) => !item.ok)
console.log(`\n${report.length - failed.length}/${report.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
