// 验收：对话里的工具行点开后能看到调用参数与返回内容
import fs from 'node:fs'

const port = Number(process.env.OCW_CDP_PORT || process.argv[2] || 9231)
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
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || '脚本失败')
  return result.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const report = []
const check = (name, ok, detail = '') => {
  report.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

check('页面有聊天输入框', await evaluate(`!!document.querySelector('.chat-input')`))

// 展开「使用了 N 个工具」块
const opened = await evaluate(`(() => {
  const btn = document.querySelector('.chat-tools-summary')
  if (!btn) return false
  const expanded = btn.parentElement?.querySelector('.chat-tools-list')
  if (!expanded) btn.click()
  return true
})()`)
check('找到工具汇总并展开', opened)
await sleep(500)

const rows = await evaluate(`document.querySelectorAll('.chat-tool-entry').length`)
check('工具行存在', rows > 0, `rows=${rows}`)

// 找第一个有内容的工具行并点开
const clicked = await evaluate(`(() => {
  const toggles = [...document.querySelectorAll('.chat-tool-toggle')].filter((b) => !b.disabled)
  if (toggles.length === 0) return null
  const t = toggles[toggles.length - 1]
  t.click()
  return t.textContent.trim()
})()`)
check('点开了有内容的工具行', Boolean(clicked), clicked ?? '没有可展开的工具')
await sleep(400)

const body = await evaluate(`(() => {
  const pre = [...document.querySelectorAll('.chat-tool-body .chat-tool-pre')]
  return {
    bodies: document.querySelectorAll('.chat-tool-body').length,
    pres: pre.length,
    labels: [...document.querySelectorAll('.chat-tool-body .chat-tool-label')].map((n) => n.textContent.trim()),
    text: pre.map((n) => n.textContent).join('\\n').slice(0, 400),
    len: pre.reduce((n, p) => n + p.textContent.length, 0),
  }
})()`)
check('出现展开面板', body.bodies > 0, `bodies=${body.bodies}`)
check('有「调用参数」小节', body.labels.includes('调用参数'), body.labels.join('/'))
check('展开内容非空', body.len > 0, `len=${body.len}`)
if (body.text) console.log('\n--- 展开内容前 400 字 ---\n' + body.text + '\n---')

const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.mkdirSync('.tmp', { recursive: true })
fs.writeFileSync('.tmp/verify-tool-output.png', Buffer.from(shot.data, 'base64'))
fs.writeFileSync('.tmp/verify-tool-output.json', JSON.stringify({ body, report }, null, 2))

const failed = report.filter((item) => !item.ok)
process.stdout.write(`\n${failed.length === 0 ? '工具内容展开验收通过' : `${failed.length} 项失败`}\n`)
ws.close()
process.exit(failed.length === 0 ? 0 : 1)
