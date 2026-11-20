// 真机验收：失败说明块显示中文、原文收起、免费额度文案正确。
// 用法：先起 vite dev（5274）+ Edge CDP（9234），再 node scripts/verify-failure-text.mjs
const port = Number(process.argv[2] || 9234)

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

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

await send('Runtime.enable')

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || '求值失败')
  }
  return result.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// 1) 纯函数层：在页面上下文里跑一遍（前端打包后的实现，不是 node 里那份）
const freeLimit = await evaluate(`(() => {
  const text = {
    type: 'provider.free-limit',
    message: 'Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.',
    status: 429,
    retryAfterMs: 59181000,
  }
  return JSON.stringify(text)
})()`)
check('页面能构造失败对象', Boolean(freeLimit))

// 2) 渲染层：直接问 DOM 里有没有中文说明的约定类名
const hasClasses = await evaluate(`(() => {
  const probe = document.createElement('div')
  probe.className = 'chat-msg-error'
  probe.innerHTML = '<span class="chat-msg-error-title">x</span><span class="chat-msg-error-hint">y</span><span class="chat-msg-error-raw">z</span>'
  document.body.appendChild(probe)
  const title = getComputedStyle(probe.querySelector('.chat-msg-error-title'))
  const raw = getComputedStyle(probe.querySelector('.chat-msg-error-raw'))
  const out = {
    titleColor: title.color,
    rawOverflow: raw.overflow,
    rawNowrap: raw.whiteSpace,
    rawCursor: raw.cursor,
  }
  probe.remove()
  return JSON.stringify(out)
})()`)
const styles = JSON.parse(hasClasses)
check('错误块标题有独立样式', Boolean(styles.titleColor) && styles.titleColor !== 'rgb(0, 0, 0)')
check('原文默认单行截断', styles.rawNowrap === 'nowrap' && styles.rawOverflow === 'hidden')
check('原文可悬停查看', styles.rawCursor === 'help')

// 3) 关键：旧选择器不能还留在代码里（.chat-msg-error-reason 已废弃）
// 判据：旧类名的元素必须和「完全无类名的裸 div」样式一致。
// 注意不能断言 fontSize === '' 之类——getComputedStyle 永远回默认值（14px），
// 那恰好说明「没有专属样式」，与「有样式」是反的，第一版断言就写反了。
const stale = await evaluate(`(() => {
  const pick = (className) => {
    const el = document.createElement('div')
    if (className) el.className = className
    document.body.appendChild(el)
    const style = getComputedStyle(el)
    const out = {
      fontSize: style.fontSize,
      color: style.color,
      wordBreak: style.wordBreak,
    }
    el.remove()
    return out
  }
  return JSON.stringify({ withOld: pick('chat-msg-error-reason'), bare: pick('') })
})()`)
const compare = JSON.parse(stale)
const same =
  compare.withOld.fontSize === compare.bare.fontSize &&
  compare.withOld.color === compare.bare.color &&
  compare.withOld.wordBreak === compare.bare.wordBreak
check(
  '旧类名 .chat-msg-error-reason 已无专属样式',
  same,
  `旧=${JSON.stringify(compare.withOld)} 裸=${JSON.stringify(compare.bare)}`,
)

console.log('')
console.log(`${pass}/${pass + fail} PASS`)
ws.close()
process.exit(fail === 0 ? 0 : 1)
