// 真机验收：消息回撤（Revert）。
// 用法：先起 vite dev（127.0.0.1:5273），再
//   node scripts/verify-revert.mjs <cdpPort> [root]
// 默认 cdpPort=9223、root=F:\opencode\workbench。
const port = Number(process.argv[2] || 9223)
const root = process.argv[3] || 'F:\\opencode\\workbench'

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

async function waitFor(expression, timeoutMs = 60000, step = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(expression)
    if (value) return value
    await sleep(step)
  }
  return null
}

// 1. 先设置工作区根：没有 root 时页面显示的是选目录引导页，不会有 .chat-input
const rootNow = await evaluate(`localStorage.getItem('oc-workbench:root')`)
if (rootNow !== root) {
  await evaluate(`localStorage.setItem('oc-workbench:root', ${JSON.stringify(root)})`)
  await send('Page.reload', { ignoreCache: true })
  await sleep(4000)
}

const ready = await waitFor(`Boolean(document.querySelector('.chat-input'))`, 30000)
if (!ready) {
  const text = await evaluate('document.body.innerText.slice(0, 300)')
  throw new Error(`页面没有聊天输入框：${text}`)
}

// 等后端连上（发送按钮可用 / 能拉到会话列表）
await waitFor(`!document.querySelector('.chat-placeholder')?.textContent?.includes('等待后端连接')`, 30000)

const probe = `revert-probe-${Date.now()}`
const probeEdited = `${probe}-edited`

// 2. 新建会话并发送一条短消息
await evaluate(`document.querySelector('.chat-new').click()`)
await sleep(600)
await evaluate(`
  (() => {
    const el = document.querySelector('.chat-input')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(probe)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  })()
`)
await sleep(300)
await evaluate(`document.querySelector('.chat-send').click()`)

const appeared = await waitFor(
  `[...document.querySelectorAll('.chat-msg.user .chat-bubble')].some((el) => el.textContent.includes(${JSON.stringify(probe)}))`,
  60000,
)
check('消息发出去并出现在列表里', Boolean(appeared))
if (!appeared) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(1)
}

// 3. 生成中回撤按钮应当禁用；把它 interrupt 掉，等 idle
const disabledWhileRunning = await evaluate(`Boolean(document.querySelector('.chat-revert[disabled]'))`)
check('生成中回撤按钮禁用', disabledWhileRunning)

if (await evaluate(`Boolean(document.querySelector('.chat-send.stop'))`)) {
  await evaluate(`
    (async () => {
      const list = await fetch('/api/session?limit=5&order=desc&parentID=null').then((r) => r.json())
      const rows = Array.isArray(list) ? list : (list.data ?? [])
      const own = rows.find((s) => s.metadata?.source === 'oc-workbench' && s.metadata?.kind !== 'terminal')
      if (own?.id) {
        await fetch('/api/session/' + encodeURIComponent(own.id) + '/interrupt', { method: 'POST' })
      }
      return own?.id ?? null
    })()
  `)
}
const revertReady = await waitFor(`Boolean(document.querySelector('.chat-revert:not([disabled])'))`, 60000)
check('回合结束后回撤按钮可用', Boolean(revertReady))

// 4. 点回撤 → 出现二次确认 → 只回撤消息
await evaluate(`document.querySelector('.chat-revert').click()`)
await sleep(300)
const confirmShown = await evaluate(
  `[...document.querySelectorAll('.chat-revert-confirm .chat-revert-do')].map((el) => el.textContent)`,
)
check('出现「消息和文件 / 只回撤消息」确认项', Array.isArray(confirmShown) && confirmShown.length === 2, JSON.stringify(confirmShown))

await evaluate(`
  (() => {
    const buttons = [...document.querySelectorAll('.chat-revert-confirm .chat-revert-do')]
    const onlyMessages = buttons.find((el) => el.textContent.includes('只回撤消息'))
    onlyMessages.click()
  })()
`)

const hidden = await waitFor(
  `![...document.querySelectorAll('.chat-msg.user .chat-bubble')].some((el) => el.textContent.includes(${JSON.stringify(probe)}))`,
  20000,
)
check('回撤后界面不再显示这条消息', Boolean(hidden))

const draftBack = await waitFor(
  `document.querySelector('.chat-input')?.value === ${JSON.stringify(probe)}`,
  10000,
)
check('原文回到输入框', Boolean(draftBack))

const noticeText = await evaluate(`document.querySelector('.chat-notice-text')?.textContent ?? ''`)
check('提示条说明已回撤', noticeText.includes('已回撤'), noticeText)

const hasCancel = await evaluate(`Boolean(document.querySelector('.chat-notice-action'))`)
check('提示条上有取消回撤按钮', hasCancel)

// 5. 取消回撤 → 消息恢复
await evaluate(`document.querySelector('.chat-notice-action').click()`)
const restored = await waitFor(
  `[...document.querySelectorAll('.chat-msg.user .chat-bubble')].some((el) => el.textContent.includes(${JSON.stringify(probe)}))`,
  20000,
)
check('取消回撤后消息恢复显示', Boolean(restored))
const noticeGone = await waitFor(`!document.querySelector('.chat-notice')`, 10000)
check('取消回撤后提示条消失', Boolean(noticeGone))

// 6. 再回撤一次 → 编辑后发送 → 服务端 commit，旧消息被删
await waitFor(`Boolean(document.querySelector('.chat-revert:not([disabled])'))`, 30000)
await evaluate(`document.querySelector('.chat-revert').click()`)
await sleep(300)
await evaluate(`
  (() => {
    const buttons = [...document.querySelectorAll('.chat-revert-confirm .chat-revert-do')]
    buttons.find((el) => el.textContent.includes('只回撤消息')).click()
  })()
`)
await waitFor(`!document.querySelector('.chat-turn') || ![...document.querySelectorAll('.chat-msg.user .chat-bubble')].some((el) => el.textContent.includes(${JSON.stringify(probe)}))`, 20000)

await sleep(500)
await evaluate(`
  (() => {
    const el = document.querySelector('.chat-input')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(probeEdited)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('.chat-send').click()
  })()
`)

const editedShown = await waitFor(
  `[...document.querySelectorAll('.chat-msg.user .chat-bubble')].some((el) => el.textContent.includes(${JSON.stringify(probeEdited)}))`,
  60000,
)
check('改完重新发送后出现新消息', Boolean(editedShown))

const oldGone = await evaluate(
  `![...document.querySelectorAll('.chat-msg.user .chat-bubble')].some((el) => el.textContent.trim() === ${JSON.stringify(probe)})`,
)
check('旧消息已被真正删除', oldGone)

// 收尾：中断这次生成，别让模型白跑
await sleep(1000)
await evaluate(`
  (async () => {
    const list = await fetch('/api/session?limit=5&order=desc&parentID=null').then((r) => r.json())
    const rows = Array.isArray(list) ? list : (list.data ?? [])
    const own = rows.find((s) => s.metadata?.source === 'oc-workbench' && s.metadata?.kind !== 'terminal')
    if (own?.id) await fetch('/api/session/' + encodeURIComponent(own.id) + '/interrupt', { method: 'POST' })
    return true
  })()
`)

const failed = report.filter((item) => !item.ok)
console.log(`\n${report.length - failed.length}/${report.length} PASS`)
if (failed.length > 0) {
  console.log(JSON.stringify(failed, null, 2))
  process.exit(1)
}
