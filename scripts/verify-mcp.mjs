// 用 CDP 驱动真实工作台，验证「输入框下方的 MCP 读数与展开面板」。
// 用法：$env:OCW_CDP_PORT=9231; node scripts/verify-mcp.mjs   （真机 exe）
//      node scripts/verify-mcp.mjs                            （dev，需先起 vite:5273 并开 Edge 远程调试）
// 前置：以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9231 启动 exe。
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

// 1. 页面要有聊天输入框（没有就说明没打开项目）
const hasInput = await evaluate(`!!document.querySelector('.chat-input')`)
check('页面渲染出聊天输入框', hasInput)
if (!hasInput) {
  ws.close()
  process.exit(1)
}

// 2. 等 MCP 读数出现（首次挂载要拉一次 /api/mcp）
let chip = null
for (let i = 0; i < 40; i += 1) {
  chip = await evaluate(`(() => {
    const el = document.querySelector('[data-composer-stat="mcp"]')
    return el ? { text: el.textContent.trim(), title: el.title, expanded: el.getAttribute('aria-expanded') } : null
  })()`)
  if (chip) break
  await sleep(500)
}

check('出现 MCP 读数', !!chip, chip?.text ?? '未出现')
if (!chip) {
  ws.close()
  process.exit(1)
}

const m = /^MCP (\d+)\/(\d+)$/.exec(chip.text)
check('读数是「已连接/总数」格式', !!m, chip.text)

// 3. 点击展开，断言面板内容
await evaluate(`document.querySelector('[data-composer-stat="mcp"]').click()`)
await sleep(300)

const panel = await evaluate(`(() => {
  const pop = document.querySelector('.chat-stat-pop-mcp')
  if (!pop) return null
  const rows = [...pop.querySelectorAll('.chat-stat-mcp-item')].map((row) => ({
    name: row.querySelector('.chat-stat-mcp-name')?.textContent?.trim() ?? '',
    state: row.querySelector('.chat-stat-mcp-state')?.textContent?.trim() ?? '',
    bad: row.classList.contains('bad'),
    hasError: !!row.querySelector('.chat-stat-mcp-err'),
  }))
  return {
    head: pop.querySelector('.chat-stat-head-counts')?.textContent?.trim() ?? '',
    rows,
    error: pop.querySelector('.chat-stat-mcp-error')?.textContent?.trim() ?? '',
    refresh: !!pop.querySelector('.chat-stat-refresh'),
  }
})()`)

check('点击后展开 MCP 面板', !!panel, panel ? '' : '面板未出现')
if (!panel) {
  ws.close()
  process.exit(1)
}

const connected = Number(m?.[1] ?? -1)
const total = Number(m?.[2] ?? -1)
check('面板行数等于总数', panel.rows.length === total, `rows=${panel.rows.length} total=${total}`)
check(
  '面板头部已连接数与读数一致',
  panel.head.startsWith(`已连接 ${connected}/${total}`),
  panel.head,
)
check('有「重新检测」按钮', panel.refresh)

// 异常优先：第一条坏行之前不能出现已连接行
const firstOk = panel.rows.findIndex((row) => row.state === '已连接')
const firstBad = panel.rows.findIndex((row) => row.bad)
check(
  '异常服务器排在已连接前面',
  firstBad === -1 || firstOk === -1 || firstBad < firstOk,
  `firstBad=${firstBad} firstOk=${firstOk}`,
)

// 失败行必须带错误原文（有失败时）
if (panel.rows.some((row) => row.state === '连接失败')) {
  check('失败行展示错误原因', panel.rows.some((row) => row.bad && row.hasError))
}

// 4. 点「重新检测」后数据不丢、面板还在
await evaluate(`document.querySelector('.chat-stat-refresh').click()`)
await sleep(1200)
const after = await evaluate(`(() => {
  const pop = document.querySelector('.chat-stat-pop-mcp')
  return pop ? pop.querySelectorAll('.chat-stat-mcp-item').length : -1
})()`)
check('重新检测后面板仍在且有数据', after === total, `after=${after} total=${total}`)

// 5. 截图留证（面板区域）
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.mkdirSync('.tmp', { recursive: true })
fs.writeFileSync('.tmp/verify-mcp.png', Buffer.from(shot.data, 'base64'))

// 6. 点空白处收起
await evaluate(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
await sleep(200)
const closed = await evaluate(`!document.querySelector('.chat-stat-pop-mcp')`)
check('点外面收起面板', closed)

fs.writeFileSync('.tmp/verify-mcp.json', JSON.stringify({ chip, panel, report }, null, 2))

const failed = report.filter((item) => !item.ok)
process.stdout.write(`\n${failed.length === 0 ? 'MCP 读数验收通过' : `${failed.length} 项失败`}\n`)
ws.close()
process.exit(failed.length === 0 ? 0 : 1)
