// 验证「切换项目」后草稿不丢、也不串到别的项目。
// 用法：node scripts/verify-draft-projects.mjs [cdpPort]
//
// 注意：项目标签按「最近使用」排序，切过去之后顺序会变，所以这里一律
// 按 title（完整路径）定位标签，不能用下标。
const port = Number(process.argv[2] || 9232)

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

const paths = await evaluate(`Array.from(document.querySelectorAll('.project-tab')).map((el) => el.getAttribute('title') || '')`)
if (paths.length < 2) {
  process.stdout.write(`只发现 ${paths.length} 个项目（${JSON.stringify(paths)}），跳过跨项目测试\n`)
  ws.close()
  process.exit(0)
}
const origin = paths[0]
const other = paths[1]

const MARK = '跨项目草稿-' + Date.now().toString(36)
// 另一个项目本来可能就有一份草稿（上次测试或用户自己打的），那不算串味；
// 真正要保证的是它看不到当前项目这份 MARK。
const otherBefore = await evaluate(`document.querySelector('.chat-input')?.value ?? ''`)

// 在当前项目打字
await evaluate(`(async () => {
  const input = document.querySelector('.chat-input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, ${JSON.stringify(MARK)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(800)

// 按 title 找标签并点击
const clickByTitle = (title) => `(async () => {
  const tab = Array.from(document.querySelectorAll('.project-tab')).find((el) => (el.getAttribute('title') || '') === ${JSON.stringify(title)})
  if (!tab) return false
  tab.click()
  return true
})()`

const clickedOther = await evaluate(clickByTitle(other))
await sleep(2500)
const inOther = await evaluate(`document.querySelector('.chat-input')?.value ?? null`)
check('切到另一个项目：标签点到了', clickedOther === true, other)
check('另一个项目没拿到当前项目的文字（没串味）', inOther !== MARK, `value=${JSON.stringify(inOther)} before=${JSON.stringify(otherBefore)}`)

const clickedBack = await evaluate(clickByTitle(origin))
check('切回原项目：标签点到了', clickedBack === true, origin)
const back = await evaluate(`(async () => {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 200))
    const value = document.querySelector('.chat-input')?.value
    if (value) return value
  }
  return document.querySelector('.chat-input')?.value ?? null
})()`)
check('切回原项目后草稿还在', back === MARK, `value=${JSON.stringify(back)}`)

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
