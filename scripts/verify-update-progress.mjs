// 真机/dev 验收：版本与更新面板的进度条。
// 用法：先起 vite dev（http://127.0.0.1:5273）+ Edge CDP，再
//   node scripts/verify-update-progress.mjs <cdpPort>
//
// 覆盖的断言：
//   1. 打开面板能读到「最新版本」（dev 由 scripts/dev-local-update.mjs 提供）
//   2. 点「立即更新」后出现进度条，且百分比出现并在推进（不是卡在 0%）
//   3. 下载中途手动再打一次 /local/update/check（模拟重复检测），进度条不能被清掉/回退
//   4. 完成后按钮变「已就绪」并禁用，顶栏不再亮「有新版本」点
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

const clickText = (scope, text) =>
  `[...document.querySelectorAll('${scope} button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})?.click()`

// 0. 先整页刷新：上一轮验收可能把页面留在「已更新」状态（settled），
//    不重载就等不到「最新版本」那一行。
await send('Page.reload', { ignoreCache: true })
await delay(1800)

// 1. 打开更新面板
await waitFor(`Boolean(document.querySelector('.topbar'))`, 30000)
const opened = await evaluate(`(() => {
  const chip = document.querySelector('.update-chip')
  if (!chip) return false
  chip.click()
  return true
})()`)
check('顶栏有版本按钮并已点开', opened === true)

const dialog = await waitFor(`Boolean(document.querySelector('.update-dialog'))`, 8000)
check('更新面板打开', Boolean(dialog))
if (!dialog) {
  const text = await evaluate('document.body.innerText.slice(0, 300)')
  throw new Error(`面板没打开：${text}`)
}

// 2. 等检查结束：出现最新版本 + 「立即更新」可点
const latest = await waitFor(
  `document.querySelector('.update-dialog')?.textContent?.includes('v9.9.9')`,
  20000,
)
check('读到最新版本 v9.9.9', Boolean(latest))
const canApply = await waitFor(
  `(() => {
    const btn = document.querySelector('.update-actions .update-btn.primary')
    return Boolean(btn && !btn.disabled && btn.textContent.includes('立即更新'))
  })()`,
  20000,
)
check('「立即更新」可点', Boolean(canApply))

// 3. 点更新，采样进度
await evaluate(clickText('.update-actions', '立即更新'))
const seen = []
const deadline = Date.now() + 25000
let midChecked = false
let beforeMid = null
let afterMid = null
while (Date.now() < deadline) {
  const text = await evaluate(
    `document.querySelector('.update-progress-text')?.textContent ?? ''`,
  )
  if (text) seen.push(text)
  const percentMatch = /下载中 (\d+)%/.exec(text ?? '')
  // 下载中途（约 30%~70% 之间）手动打一次 check，模拟「重复检测」
  if (!midChecked && percentMatch) {
    const percent = Number(percentMatch[1])
    if (percent >= 30 && percent <= 80) {
      midChecked = true
      beforeMid = text
      await evaluate(`fetch('/local/update/check').then((r) => r.json())`)
      await delay(150)
      afterMid = await evaluate(
        `document.querySelector('.update-progress-text')?.textContent ?? ''`,
      )
    }
  }
  // 完成信号只能用「检查按钮变已就绪」：主按钮在点下去的瞬间就 disabled 了，
  // 拿它当退出条件会只采到一条 0%。
  const done = await evaluate(
    `(() => {
      const btn = document.querySelector('.update-actions .update-btn:not(.primary)')
      return Boolean(btn && btn.disabled && btn.textContent.includes('已就绪'))
    })()`,
  )
  if (done) break
  await delay(150)
}

const percentages = seen
  .map((text) => /下载中 (\d+)%/.exec(text))
  .filter(Boolean)
  .map((match) => Number(match[1]))

check('出现下载进度条', seen.some((text) => text.includes('下载中')), JSON.stringify(seen.slice(-3)))
check(
  '进度在推进（出现过 >0% 且单调不回退）',
  percentages.length > 1 &&
    Math.max(...percentages) > 0 &&
    percentages.every((value, index) => index === 0 || value >= percentages[index - 1]),
  JSON.stringify(percentages),
)

// 4. 重复检测不能覆盖进度
check(
  '下载中被再次检查后进度条仍在且不回退',
  Boolean(beforeMid && afterMid) &&
    afterMid.includes('下载中') &&
    Number(/下载中 (\d+)%/.exec(afterMid)?.[1] ?? -1) >=
      Number(/下载中 (\d+)%/.exec(beforeMid)?.[1] ?? 0),
  `${beforeMid ?? '未采样到'} → ${afterMid ?? '未采样到'}`,
)

// 5. 完成后：按钮禁用、检查按钮变「已就绪」、顶栏提示点消失
const settled = await waitFor(
  `(() => {
    const checkBtn = document.querySelector('.update-actions .update-btn:not(.primary)')
    const applyBtn = document.querySelector('.update-actions .update-btn.primary')
    return Boolean(
      checkBtn &&
        checkBtn.disabled &&
        checkBtn.textContent.includes('已就绪') &&
        applyBtn &&
        applyBtn.disabled,
    )
  })()`,
  20000,
)
check('更新完成：检查按钮禁用并显示「已就绪」', Boolean(settled))
const dotCount = await evaluate(`document.querySelectorAll('.update-chip .update-dot:not(.busy)').length`)
check('更新后顶栏不再提示有新版本', dotCount === 0, `提示点 ${dotCount} 个`)
const readyText = await evaluate(
  `document.querySelector('.update-dialog')?.textContent.includes('更新包已就绪') ?? false`,
)
check('面板显示「更新包已就绪」', readyText === true)

const failed = report.filter((item) => !item.ok)
process.stdout.write(`\n${report.length - failed.length}/${report.length} PASS\n`)
try {
  ws.close()
} catch {
  // 已关闭
}
await delay(80)
process.exit(failed.length ? 1 : 0)
