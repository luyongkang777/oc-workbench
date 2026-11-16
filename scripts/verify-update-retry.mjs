// 真机/dev 验收：更新失败后「重试」不能被锁死。
// 用法：先起 vite dev（http://127.0.0.1:5273）+ Edge CDP，再
//   node scripts/verify-update-retry.mjs <cdpPort>
//
// 覆盖的断言（对应评审抓到的 🔴）：
//   1. 模拟失败后，面板显示失败原因，「重试更新」按钮可点
//   2. 关掉面板再打开，不能卡在「检查中…」（整块按钮全禁用）
//   3. 重开面板后「检查更新」「重试更新」都可用
//   4. 清掉失败标记后点重试，能正常走到「已就绪」
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

async function waitFor(expression, timeoutMs = 30000, step = 150) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(expression)
    if (value) return value
    await delay(step)
  }
  return null
}

const clickText = (scope, text) =>
  `[...document.querySelectorAll('${scope} button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})?.click()`

const openPanel = `(() => {
  if (document.querySelector('.update-dialog')) return true
  const chip = document.querySelector('.update-chip')
  if (!chip) return false
  chip.click()
  return true
})()`

// 干净起点
await send('Page.reload', { ignoreCache: true })
await delay(1800)
await waitFor(`Boolean(document.querySelector('.topbar'))`, 30000)

// 1. 让下一轮更新失败
const armed = await evaluate(`fetch('/local/update/simulate?fail=1', { method: 'POST' }).then((r) => r.json())`)
check('已布置「下一轮更新失败」', armed?.failNext === true, JSON.stringify(armed))

await evaluate(openPanel)
const canApply = await waitFor(
  `(() => {
    const btn = document.querySelector('.update-actions .update-btn.primary')
    return Boolean(btn && !btn.disabled && btn.textContent.includes('立即更新'))
  })()`,
  20000,
)
check('面板就绪，可以点更新', Boolean(canApply))
await evaluate(clickText('.update-actions', '立即更新'))

// 2. 等失败提示 + 重试按钮可点
const failed = await waitFor(
  `document.querySelector('.update-dialog')?.textContent?.includes('模拟失败') ?? false`,
  25000,
)
check('更新失败后显示失败原因', Boolean(failed))
const retryReady = await evaluate(`(() => {
  const btn = document.querySelector('.update-actions .update-btn.primary')
  return Boolean(btn && !btn.disabled && btn.textContent.includes('重试更新'))
})()`)
check('「重试更新」可点', retryReady === true)

// 3. 关掉面板再打开：不能锁死在「检查中…」
await evaluate(`document.querySelector('.update-close')?.click()`)
const closed = await waitFor(`!document.querySelector('.update-dialog')`, 5000)
check('失败后可以关闭面板', Boolean(closed))
await evaluate(openPanel)
await waitFor(`Boolean(document.querySelector('.update-dialog'))`, 5000)

const stuck = await evaluate(`(() => {
  const checkBtn = document.querySelector('.update-actions .update-btn:not(.primary)')
  const applyBtn = document.querySelector('.update-actions .update-btn.primary')
  return {
    checkText: checkBtn?.textContent?.trim() ?? '',
    checkDisabled: Boolean(checkBtn?.disabled),
    applyText: applyBtn?.textContent?.trim() ?? '',
    applyDisabled: Boolean(applyBtn?.disabled),
  }
})()`)
check(
  '重开面板没卡在「检查中…」',
  stuck.checkText !== '检查中…' && stuck.checkDisabled === false,
  JSON.stringify(stuck),
)
check(
  '重开面板后仍可重试',
  stuck.applyText === '重试更新' && stuck.applyDisabled === false,
  JSON.stringify(stuck),
)

// 4. 清掉失败标记后重试成功
await evaluate(`fetch('/local/update/simulate?fail=0', { method: 'POST' })`)
await evaluate(`(() => {
  const btn = document.querySelector('.update-actions .update-btn.primary')
  if (!btn) return false
  btn.click()
  return true
})()`)
const retried = await waitFor(
  `(() => {
    const checkBtn = document.querySelector('.update-actions .update-btn:not(.primary)')
    return Boolean(checkBtn && checkBtn.disabled && checkBtn.textContent.includes('已就绪'))
  })()`,
  30000,
)
check('重试后能走到「已就绪」', Boolean(retried))

// 5. apply 报错但后端仍在下载：界面要继续跟随，不能钉成失败
await send('Page.reload', { ignoreCache: true })
await delay(1800)
await waitFor(`Boolean(document.querySelector('.topbar'))`, 30000)
const armedNetwork = await evaluate(`fetch('/local/update/simulate?network=1', { method: 'POST' }).then((r) => r.json())`)
check('已布置「HTTP 断连但后台继续下载」', armedNetwork?.networkFailNext === true, JSON.stringify(armedNetwork))
await evaluate(openPanel)
const canApply2 = await waitFor(
  `(() => {
    const btn = document.querySelector('.update-actions .update-btn.primary')
    return Boolean(btn && !btn.disabled && btn.textContent.includes('立即更新'))
  })()`,
  20000,
)
check('网络中断场景：面板就绪', Boolean(canApply2))
await evaluate(clickText('.update-actions', '立即更新'))
const followed = await waitFor(
  `(() => {
    const checkBtn = document.querySelector('.update-actions .update-btn:not(.primary)')
    return Boolean(checkBtn && checkBtn.disabled && checkBtn.textContent.includes('已就绪'))
  })()`,
  40000,
)
check('apply 报错但后端仍在下载时继续跟随并完成', Boolean(followed))
const errText = await evaluate(`document.querySelector('.update-dialog .update-error')?.textContent ?? ''`)
check('没有把界面钉成失败', !errText.includes('模拟网络中断'), errText)

const failedCount = report.filter((item) => !item.ok)
process.stdout.write(`\n${report.length - failedCount.length}/${report.length} PASS\n`)
try {
  ws.close()
} catch {
  // 已关闭
}
await delay(80)
process.exit(failedCount.length ? 1 : 0)
