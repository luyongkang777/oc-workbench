// 真机/dev 验收：用量面板。
// 用法：先起 vite dev（http://127.0.0.1:5273）+ Edge CDP，再
//   node scripts/verify-usage.mjs <cdpPort>
//
// 覆盖：
//   1. 顶栏有「用量」按钮，点开面板
//   2. 四张汇总卡都有值（数据来自本机 magpie 的 usage.jsonl）
//   3. 图表按范围出桶：今天 24 根、7 天 7 根
//   4. 切指标（费用）后图还在
//   5. 分组切到「客户端」，第一行是「本地会话」
//   6. 供应商筛选能生效；Esc 能关面板
import { setTimeout as delay } from 'node:timers/promises'

const port = Number(process.argv[2] || 9223)

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((target) => target.type === 'page')
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

const report = []
function check(name, ok, detail = '') {
  report.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

async function waitFor(expression, timeoutMs = 30000, step = 200) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(expression)
    if (value) return value
    await delay(step)
  }
  return null
}

// 干净起点
await send('Page.reload', { ignoreCache: true })
await delay(1800)
await waitFor(`Boolean(document.querySelector('.topbar'))`, 30000)

const hasButton = await evaluate(
  `Boolean([...document.querySelectorAll('.topbar-iconbtn')].find((b) => (b.getAttribute('title') || '').includes('用量')))`,
)
check('顶栏有「用量」按钮', hasButton === true)

await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.topbar-iconbtn')].find((b) => (b.getAttribute('title') || '').includes('用量'))
  if (btn) btn.click()
  return Boolean(btn)
})()`)
const opened = await waitFor(`Boolean(document.querySelector('.usage-panel.open'))`, 8000)
check('用量面板打开', Boolean(opened))

// 默认范围是今天：小时桶固定 24 根（今天还没请求也要占位）
const barsToday = await waitFor(
  `document.querySelectorAll('.usage-bars .usage-bar').length === 24`,
  15000,
)
const todayCount = await evaluate(`document.querySelectorAll('.usage-bars .usage-bar').length`)
check('今天按小时分桶（24 根柱子）', Boolean(barsToday), `${todayCount} 根`)

// 先切到 7 天：日志最后一条可能不是今天，「今天」空着会误判成没数据
await evaluate(`[...document.querySelectorAll('.usage-tab')].find((b) => b.textContent.trim() === '7 天')?.click()`)
// 必须等 tab 真的切过去：今天有数据时，下面的卡片断言会在切换完成前就通过，
// 读到的是今天的数字（实测踩过）
const switched = await waitFor(`document.querySelector('.usage-tab.active')?.textContent.trim() === '7 天'`, 8000)
// 切完还要等数据真的换掉：卡片是异步刷新的，只等 tab 会读到今天的旧值
const weekReady = await waitFor(`document.querySelectorAll('.usage-labels .usage-label').length === 7`, 15000)
check('切到 7 天并拿到数据', Boolean(switched && weekReady))
// 等数据回来：Token 卡必须不是 0（$0 和 — 不算「有值」）
const cards = await waitFor(
  `(() => {
    const values = [...document.querySelectorAll('.usage-card-value')].map((el) => el.textContent.trim())
    return values.length === 4 && values[0] !== '0' && values[1] !== '0' && values[2] !== '$0' && values[3] !== '—'
  })()`,
  20000,
)
const cardText = await evaluate(`[...document.querySelectorAll('.usage-card-value')].map((el) => el.textContent.trim())`)
check('四张汇总卡都有值（7 天）', Boolean(cards), JSON.stringify(cardText))

const cardLabels = await evaluate(`[...document.querySelectorAll('.usage-card-label')].map((el) => el.textContent.trim())`)
check(
  '卡片顺序为 Token / 请求 / 费用 / 缓存命中率',
  JSON.stringify(cardLabels) === JSON.stringify(['Token', '请求', '费用', '缓存命中率']),
  JSON.stringify(cardLabels),
)

const errorText = await evaluate(`document.querySelector('.usage-error')?.textContent ?? ''`)
check('没有显示读日志失败', errorText === '', errorText)

// 图表：今天 24 根


// 切 7 天 → 7 根
await evaluate(`[...document.querySelectorAll('.usage-tab')].find((b) => b.textContent.trim() === '7 天')?.click()`)
// 已经是 7 天：等柱子补齐
const barsWeek = await waitFor(
  `document.querySelectorAll('.usage-bars .usage-bar').length === 7`,
  15000,
)
const weekCount = await evaluate(`document.querySelectorAll('.usage-bars .usage-bar').length`)
check('7 天按天分桶（7 根柱子）', Boolean(barsWeek), `${weekCount} 根`)

// 切指标到费用：柱子还在
await evaluate(`[...document.querySelectorAll('.usage-chart-tab')].find((b) => b.textContent.trim() === '费用')?.click()`)
await delay(300)
const barsCost = await evaluate(`document.querySelectorAll('.usage-bars .usage-bar').length`)
check('切到「费用」指标后图还在', barsCost === 7, `${barsCost} 根`)
const peakText = await evaluate(`document.querySelector('.usage-chart-peak')?.textContent ?? ''`)
check('费用模式显示峰值', peakText.includes('峰值'), peakText)

// 分组切「客户端」：第一行是本地会话
await evaluate(`[...document.querySelectorAll('.usage-breakdown .usage-chart-tab')].find((b) => b.textContent.trim() === '客户端')?.click()`)
await delay(300)
const firstAgent = await evaluate(`document.querySelector('.usage-source-name')?.textContent ?? ''`)
check('客户端分组第一行是「本地会话」', firstAgent === '本地会话', firstAgent)

// 供应商筛选：选第一个真实选项
const filterPick = await evaluate(`(() => {
  const select = document.querySelector('.usage-select')
  if (!select) return null
  const option = [...select.options].find((item) => item.value)
  if (!option) return null
  select.value = option.value
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return { value: option.value, label: option.textContent.trim() }
})()`)
await delay(1500)
await evaluate(`[...document.querySelectorAll('.usage-breakdown .usage-chart-tab')].find((b) => b.textContent.trim() === '服务商')?.click()`)
await delay(400)
const filteredRows = await evaluate(`[...document.querySelectorAll('.usage-breakdown .usage-source-name')].map((el) => el.textContent.trim())`)
check(
  '供应商筛选后分组只剩选中那家',
  Boolean(filterPick) && filteredRows.length === 1 && filteredRows[0] === filterPick.label,
  JSON.stringify({ filterPick, filteredRows }),
)

// Esc 关闭
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
const closed = await waitFor(`!document.querySelector('.usage-panel.open')`, 5000)
check('Esc 能关闭面板', Boolean(closed))

const failed = report.filter((item) => !item.ok)
process.stdout.write(`\n${report.length - failed.length}/${report.length} PASS\n`)
try {
  ws.close()
} catch {
  // 已关闭
}
await delay(80)
process.exit(failed.length ? 1 : 0)
