// 真机验收：模型下拉里不该再出现内置 provider 自带的模型。
// 用法：先起 vite dev（5274）+ Edge CDP（9234），再 node scripts/verify-model-filter.mjs
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
// 让页面可见（后台标签里 DOM 照样在，但保险起见）
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
// 设置项目根：新 profile 没有「最近项目」时文件树为空，先写 localStorage
await send('Runtime.evaluate', {
  expression: `localStorage.setItem('oc-workbench:root', 'F:\\\\opencode\\\\workbench')`,
  returnByValue: true,
})
await send('Runtime.evaluate', { expression: 'location.reload()', returnByValue: true }).catch(() => {})
await new Promise((r) => setTimeout(r, 5000))

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
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

// 等页面就绪 + 连上服务
const ready = await (async () => {
  for (let i = 0; i < 30; i += 1) {
    const ok = await evaluate(`Boolean(document.querySelector('.model-toggle'))`)
    if (ok) return true
    await sleep(500)
  }
  return false
})()
check('页面已渲染出模型按钮', ready === true)
if (!ready) {
  console.log('')
  console.log(`${pass}/${pass + fail} PASS`)
  ws.close()
  process.exit(1)
}

// 打开模型下拉
await evaluate(`document.querySelector('.model-toggle').click()`)
await sleep(1200)

const items = await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('.model-item')]
  return JSON.stringify(nodes.map((el) => ({
    name: el.querySelector('.model-name')?.textContent ?? '',
    provider: el.querySelector('.model-provider')?.textContent ?? '',
  })))
})()`)
const list = JSON.parse(items)
console.log('下拉里的模型:', list.length, '个')
for (const item of list.slice(0, 20)) console.log(`  ${item.name}  ← ${item.provider}`)

// 核心断言：不能有 provider 正好叫 opencode 的（内置那个）
const builtinLeft = list.filter((item) => item.provider === 'opencode')
check(
  '内置 provider 自带的模型已隐藏',
  builtinLeft.length === 0,
  builtinLeft.length ? `残留 ${builtinLeft.length} 个：${builtinLeft.map((i) => i.name).join(', ')}` : '',
)

// 用户自配的那条必须还在
const selfOwned = list.filter((item) => item.provider === 'opencode-free')
check('自己配的 opencode-free 仍在列表里', selfOwned.length > 0, `${selfOwned.length} 个（应与配置里的模型数一致）`)

// 其它自配 provider 也在
const others = list.filter((item) => ['deepseek-official', 'command-code', 'opencode-zen'].includes(item.provider))
check('其它自配服务商的模型仍在', others.length > 0, `${others.length} 个`)

// 列表不能空
check('下拉不是空的', list.length > 0, `${list.length} 个`)

console.log('')
console.log(`${pass}/${pass + fail} PASS`)
ws.close()
process.exit(fail === 0 ? 0 : 1)
