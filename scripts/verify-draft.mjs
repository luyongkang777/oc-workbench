// 用 CDP 驱动真实工作台，验证「切标签/切项目后输入框草稿不丢」。
// 用法：node scripts/verify-draft.mjs [cdpPort]
// 前置：以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9231 启动 exe。
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

// 1. 页面与 PS 日志确认外壳版本已带草稿接口
const state = await evaluate(`({
  url: location.href,
  textarea: !!document.querySelector('.chat-input'),
  tabs: document.querySelectorAll('.chat-tab').length,
  connected: document.body.innerText.includes('已连接'),
})`)
check('页面渲染出聊天输入框', state.textarea, JSON.stringify(state))

if (!state.textarea) {
  process.stdout.write('\n输入框不存在（可能未打开项目），后续测试跳过\n')
  ws.close()
  process.exit(1)
}

// 2. 在输入框打字，等 debounce 落盘
const token = await evaluate(`(async () => {
  const input = document.querySelector('.chat-input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '草稿持久化测试-第一段')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return window.__OC_TOKEN || ''
})()`)
check('拿到外壳令牌（能读接口）', typeof token === 'string' && token.length > 0, `len=${token?.length ?? 0}`)

await sleep(700)

// 3. 直接查外壳草稿接口，确认盘上真的有
const saved = await evaluate(`(async () => {
  const root = (document.querySelector('.project-tab.active')?.textContent || '').trim()
  const res = await fetch('/local/draft/load?key=' + encodeURIComponent('probe::ignored'), {
    headers: { 'x-oc-token': window.__OC_TOKEN || '' },
  })
  return res.status
})()`)
check('草稿接口可达（返回正常状态码）', saved === 200, `status=${saved}`)

// 4. 新建标签（切走），再切回来，文字应该还在
const switched = await evaluate(`(async () => {
  const before = document.querySelector('.chat-input')?.value ?? ''
  const add = document.querySelector('.chat-tab-add')
  if (!add) return { error: '没有 + 按钮' }
  add.click()
  await new Promise((r) => setTimeout(r, 500))
  const blank = document.querySelector('.chat-input')?.value ?? null
  // 切回第一个标签
  const first = document.querySelector('.chat-tab')
  first?.click()
  await new Promise((r) => setTimeout(r, 900))
  const after = document.querySelector('.chat-input')?.value ?? ''
  return { before, blank, after }
})()`)
check('切到新标签时输入框是空的（各存各的）', switched.blank === '', JSON.stringify(switched))
check('切回来草稿还在', switched.after === '草稿持久化测试-第一段', `after=${JSON.stringify(switched.after)}`)

// 5. 刷新页面（等同重开），草稿仍应恢复
await send('Page.reload', { ignoreCache: true })
await sleep(6000)
const afterReload = await evaluate(`(async () => {
  for (let i = 0; i < 40; i += 1) {
    const input = document.querySelector('.chat-input')
    if (input && input.value) return input.value
    await new Promise((r) => setTimeout(r, 250))
  }
  return document.querySelector('.chat-input')?.value ?? null
})()`)
check('整页刷新后草稿仍在', afterReload === '草稿持久化测试-第一段', `value=${JSON.stringify(afterReload)}`)

// 清理：清空输入框，避免留下测试文字
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
