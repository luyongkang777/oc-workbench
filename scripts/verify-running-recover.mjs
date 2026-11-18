// 「生成中变空闲」能不能自己发现（不靠切标签重挂载）：
//   node scripts/verify-running-recover.mjs [cdpPort]
//
// 做法：hook fetch，让第一次单条会话查询回「在跑」（busy > idle），
// 之后就让它回真值。如果 UI 能在几秒内从「停止」变回「发送」，
// 说明状态是跟着服务端走、能自愈的，不再需要切走再切回。
//
// 只对**当前打开的会话**生效，且跑完会把 fetch 还原。
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

// 打开一条空闲会话
const ready = await evaluate(`(async () => {
  if (!document.querySelector('.chat-session-item')) document.querySelector('.chat-session-toggle')?.click()
  await new Promise((r) => setTimeout(r, 600))
  const items = Array.from(document.querySelectorAll('.chat-session-item'))
  const idleItem = items.find((el) => el.querySelector('.chat-session-light.idle')) ?? items[0]
  idleItem?.querySelector('.chat-session-main')?.click()
  await new Promise((r) => setTimeout(r, 1600))
  const label = document.querySelector('.chat-send')?.textContent?.trim() ?? ''
  return { ok: label.includes('发送'), label }
})()`)
check('起始是空闲态', ready.ok, ready.label)
if (!ready.ok) {
  ws.close()
  process.exit(1)
}

// 让单条会话查询在接下来 6 秒内都回「在跑」，之后恢复真值
const armed = await evaluate(`(() => {
  const raw = window.fetch
  const until = Date.now() + 6000
  window.__fakeBusyUntil = until
  window.__restoreFetch = () => { window.fetch = raw }
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url ?? '')
    if (/\\/api\\/session\\/ses_[^/?]+$/.test(url) && Date.now() < window.__fakeBusyUntil) {
      const fake = { data: { id: 'fake', time: { busy: Date.now(), idle: Date.now() - 60_000 } } }
      return new Response(JSON.stringify(fake), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return raw.apply(this, arguments)
  }
  return true
})()`)
check('已注入「假装在跑」（持续 6 秒）', armed)

// 注意：生成中界面上有两个 .chat-send（「后台」和「停止」），
// 所以判定必须看 .chat-send.stop 存不存在，不能拿 textContent 猜。
let becameRunning = false
for (let i = 0; i < 24; i += 1) {
  await sleep(400)
  const running = await evaluate(`Boolean(document.querySelector('.chat-send.stop'))`)
  if (running) {
    becameRunning = true
    break
  }
}
check('服务端说在跑 → 界面出现「停止」按钮（状态跟着走）', becameRunning)

// 恢复真值后，UI 必须自己退出生成态，不需要切标签
let recovered = false
for (let i = 0; i < 20; i += 1) {
  await sleep(800)
  const running = await evaluate(`Boolean(document.querySelector('.chat-send.stop'))`)
  if (!running) {
    recovered = true
    break
  }
}
check('恢复真值后自己退出生成态（不靠切标签）', recovered)
check('恢复真值后自己变回「发送」（不靠切标签）', recovered)

await evaluate(`window.__restoreFetch?.()`)
ws.close()
const failed = report.filter((item) => !item.ok)
console.log(`\n${report.length - failed.length}/${report.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
