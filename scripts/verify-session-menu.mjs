// 历史会话选择器验收：
//   node scripts/verify-session-menu.mjs [cdpPort] [root]
//
// 断言 DOM 真值（.chat-sessions / .chat-session-filter / .chat-session-item /
// .chat-session-group-label），不是「没报错」。
// 会话不足两条时只验面板与搜索框，不判切换。
const port = Number(process.argv[2] || 9223)
const root = process.argv[3] || 'F:\\opencode\\workbench'

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

// 工作区根目录要先设好，否则页面停在「选目录」引导页（没有 .chat-header）
await evaluate(`localStorage.getItem('oc-workbench:root') === ${JSON.stringify(root)}
  ? 'ok'
  : localStorage.setItem('oc-workbench:root', ${JSON.stringify(root)})`)

let ready = false
for (let i = 0; i < 20; i += 1) {
  ready = await evaluate(`Boolean(document.querySelector('.chat-session-toggle'))`)
  if (ready) break
  await sleep(500)
}
if (!ready) {
  console.error('页面没有聊天区（可能是引导页 / 后端未连接）')
  ws.close()
  process.exit(1)
}

// 1. 展开面板
const opened = await evaluate(`(async () => {
  const toggle = document.querySelector('.chat-session-toggle')
  if (!document.querySelector('.chat-sessions')) toggle?.click()
  await new Promise((r) => setTimeout(r, 500))
  const filter = document.querySelector('.chat-session-filter')
  return {
    panel: Boolean(document.querySelector('.chat-sessions')),
    filter: Boolean(filter),
    focused: document.activeElement === filter,
    placeholder: filter?.placeholder ?? '',
    groups: Array.from(document.querySelectorAll('.chat-session-group-label')).map((el) => el.textContent.trim()),
    items: document.querySelectorAll('.chat-session-item').length,
    empty: document.querySelector('.chat-session-empty')?.textContent?.trim() ?? '',
  }
})()`)
check('面板已展开', opened.panel)
check('搜索框存在且自动聚焦', opened.filter && opened.focused, `placeholder=${opened.placeholder}`)
check('有条目或有空提示', opened.items > 0 || Boolean(opened.empty), `items=${opened.items} empty=${opened.empty}`)

if (opened.items > 0) {
  const allowed = ['今天', '昨天', '近 7 天', '更早']
  check('分组标题只出现约定那四种', opened.groups.every((label) => allowed.includes(label)), opened.groups.join('/'))
  check('有会话就有分组标题', opened.groups.length > 0, opened.groups.join('/'))
} else {
  check('没有会话时不出分组标题', opened.groups.length === 0, opened.groups.join('/'))
}

// 2. 搜索
if (opened.items >= 2) {
  const searched = await evaluate(`(async () => {
    const before = document.querySelectorAll('.chat-session-item').length
    const input = document.querySelector('.chat-session-filter')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'zzz不存在的关键字zzz')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
    const after = document.querySelectorAll('.chat-session-item').length
    const empty = document.querySelector('.chat-session-empty')?.textContent?.trim() ?? ''
    const cleared = Boolean(document.querySelector('.chat-session-filter-clear'))
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
    return { before, after, empty, cleared, restored: document.querySelectorAll('.chat-session-item').length }
  })()`)
  check(
    '搜索无结果时条目清零并提示',
    searched.after === 0 && searched.empty.includes('没有匹配'),
    `before=${searched.before} after=${searched.after} empty=${searched.empty}`,
  )
  check('有搜索词时出现清空按钮', searched.cleared)
  check('清空搜索后条目恢复', searched.restored === searched.before, `${searched.restored}/${searched.before}`)
}

// 3. 点条目切会话
if (opened.items >= 2) {
  const switched = await evaluate(`(async () => {
    if (!document.querySelector('.chat-session-item')) document.querySelector('.chat-session-toggle')?.click()
    await new Promise((r) => setTimeout(r, 400))
    const items = Array.from(document.querySelectorAll('.chat-session-item'))
    const activeIndex = items.findIndex((el) => el.classList.contains('active'))
    const otherIndex = activeIndex === 0 ? 1 : 0
    const beforeTitle = document.querySelector('.chat-session-toggle-text')?.textContent?.trim()
    items[otherIndex]?.querySelector('.chat-session-main')?.click()
    await new Promise((r) => setTimeout(r, 1500))
    return {
      beforeTitle,
      afterTitle: document.querySelector('.chat-session-toggle-text')?.textContent?.trim(),
      panelClosed: !document.querySelector('.chat-sessions'),
    }
  })()`)
  check('点历史会话切换了当前会话', switched.beforeTitle !== switched.afterTitle, `${switched.beforeTitle} → ${switched.afterTitle}`)
  check('选完自动收起面板', switched.panelClosed)
}

// 4. Esc：有关键字先清空；没关键字再按一次收起面板（以前永远关不掉）
if (opened.items > 0) {
  const esc = await evaluate(`(async () => {
    if (!document.querySelector('.chat-sessions')) document.querySelector('.chat-session-toggle')?.click()
    await new Promise((r) => setTimeout(r, 500))
    const input = document.querySelector('.chat-session-filter')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'zzz')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    // 第一次 Esc：只清空搜索，面板还在
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise((r) => setTimeout(r, 350))
    const afterFirst = {
      panel: Boolean(document.querySelector('.chat-sessions')),
      value: document.querySelector('.chat-session-filter')?.value ?? null,
    }
    // 第二次 Esc：收起面板
    document.querySelector('.chat-session-filter')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await new Promise((r) => setTimeout(r, 400))
    return { afterFirst, closed: !document.querySelector('.chat-sessions') }
  })()`)
  check(
    'Esc 第一次只清空搜索（面板还在）',
    esc.afterFirst.panel && esc.afterFirst.value === '',
    JSON.stringify(esc.afterFirst),
  )
  check('Esc 第二次收起面板', esc.closed)
}


ws.close()
const failed = report.filter((item) => !item.ok)
console.log(`\n${report.length - failed.length}/${report.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
