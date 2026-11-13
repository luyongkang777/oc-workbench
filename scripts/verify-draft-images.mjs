// 验证「待发送截图」跨标签/跨刷新不丢：CDP 里塞一张 1x1 PNG 到输入框附件，
// 切标签再切回来、整页刷新，缩略图都应还在。
// 用法：node scripts/verify-draft-images.mjs [cdpPort]
const port = Number(process.argv[2] || 9231)

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

// 通过真实的拖拽/粘贴入口加图：直接构造 DataTransfer + paste 事件
const added = await evaluate(`(async () => {
  const input = document.querySelector('.chat-input')
  if (!input) return { error: '没有输入框' }
  // 1x1 透明 PNG
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const file = new File([bytes], 'draft-test.png', { type: 'image/png' })
  const dt = new DataTransfer()
  dt.items.add(file)
  input.focus()
  input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 100))
    if (document.querySelectorAll('.chat-attach').length > 0) break
  }
  return {
    thumbs: document.querySelectorAll('.chat-attach').length,
    src: document.querySelector('.chat-attach-thumb')?.getAttribute('src')?.slice(0, 30) ?? null,
  }
})()`)
check('粘贴截图后出现缩略图', added.thumbs >= 1, JSON.stringify(added))

await sleep(900)

// 切新标签再切回来
const switched = await evaluate(`(async () => {
  document.querySelector('.chat-tab-add')?.click()
  await new Promise((r) => setTimeout(r, 600))
  const blank = document.querySelectorAll('.chat-attach').length
  document.querySelector('.chat-tab')?.click()
  await new Promise((r) => setTimeout(r, 1200))
  return { blank, back: document.querySelectorAll('.chat-attach').length }
})()`)
check('新标签里没有附件（各存各的）', switched.blank === 0, JSON.stringify(switched))
check('切回来附件还在', switched.back >= 1, JSON.stringify(switched))

// 整页刷新
await send('Page.reload', { ignoreCache: true })
await sleep(6000)
const afterReload = await evaluate(`(async () => {
  for (let i = 0; i < 40; i += 1) {
    if (document.querySelectorAll('.chat-attach').length > 0) break
    await new Promise((r) => setTimeout(r, 250))
  }
  const img = document.querySelector('.chat-attach-thumb')
  let loads = null
  if (img) loads = img.complete && img.naturalWidth > 0
  return { thumbs: document.querySelectorAll('.chat-attach').length, loads }
})()`)
check('刷新后附件仍在', afterReload.thumbs >= 1, JSON.stringify(afterReload))
check('刷新后缩略图能正常显示（不是破图）', afterReload.loads === true, `loads=${afterReload.loads}`)

// 清理：移除附件
await evaluate(`(async () => {
  for (const btn of document.querySelectorAll('.chat-attach-remove')) btn.click()
})()`)

const failed = report.filter((item) => !item.ok)
process.stdout.write(`\n${report.length - failed.length}/${report.length} 通过\n`)
ws.close()
process.exit(failed.length === 0 ? 0 : 1)
