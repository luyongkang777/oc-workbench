// 失败原因 → 中文说明的回归（截图里那条「这一轮没有跑完」就是这里管的）。
//
// 三条要防住：
//   1. 免费额度用光被当成普通限流 → 提示「稍后自动重试」，实际要等十几小时；
//   2. 界面直接贴英文原文 → 用户看不懂；
//   3. 「多久恢复」显示成 59181000ms 这种原始毫秒数。
import assert from 'node:assert/strict'
import test from 'node:test'

import { describeFailure, humanizeWait } from '../src/components/failureText.ts'
import { isRetryableFailure } from '../src/components/retryPolicy.ts'

/** 截图里那条真实错误（2026-11-20 实测）。 */
const FREE_LIMIT = {
  type: 'provider.free-limit',
  message:
    "Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.",
  status: 429,
  retryAfterMs: 59_181_000,
}

test('免费额度用光：说清是额度问题，并给出大约多久恢复', () => {
  const text = describeFailure(FREE_LIMIT)
  assert.equal(text.kind, 'free-limit')
  // 不能是「稍后自动重试」那类说法，用户会干等
  assert.doesNotMatch(text.hint, /自动重试/)
  assert.match(text.title, /免费/)
  assert.match(text.title, /额度/)
  // 59181000ms ≈ 16 小时，要说成人话
  assert.match(text.hint, /约 16 小时/)
  // 原文要留着，排查时能看
  assert.match(text.raw, /Free usage limit/)
})

test('免费额度用光不该自动重试（重试到额度恢复要等十几小时）', () => {
  assert.equal(isRetryableFailure(FREE_LIMIT), false)
  // 对照：普通 429 限流仍然要重试
  assert.equal(
    isRetryableFailure({ type: 'provider.rate-limit', message: 'Too many requests', status: 429 }),
    true,
  )
  assert.equal(isRetryableFailure({ type: 'provider.server', message: 'unavailable', status: 503 }), true)
})

test('含 free 但不是额度的句子不能被误判（free plan / freely / freeway）', () => {
  // 新加的规则用 /free[-_. ]?limit/i 这类精确写法，不是裸 /free\b/i——
  // 后者会把 "the free plan has no access" 也判成额度用光，直接取消重试。
  for (const text of [
    'the free plan has no access to this model',
    'try freely later',
    'freeway closed',
    'this model is free to use',
    'free of charge',
  ]) {
    const kind = describeFailure({ message: text }).kind
    assert.notEqual(kind, 'free-limit', `不该判成免费额度：${text}`)
  }
  // 真实的免费额度错误（含大小写与几种写法）都要认
  for (const text of [
    'Free usage limit reached. Connect a provider or subscribe to OpenCode Go',
    'FreeUsageLimitError',
    'FreeTierError: OpenCode free tier can only be used from within OpenCode',
    'free tier exhausted',
  ]) {
    assert.equal(describeFailure({ message: text }).kind, 'free-limit', `应该判成免费额度：${text}`)
  }
})

test('等待时长说成人话，不显示原始毫秒', () => {
  assert.equal(humanizeWait(20_000), '不到一分钟')
  assert.equal(humanizeWait(30_000), '约 1 分钟')
  assert.equal(humanizeWait(5 * 60_000), '约 5 分钟')
  assert.equal(humanizeWait(59_181_000), '约 16 小时')
  assert.equal(humanizeWait(3 * 24 * 60 * 60_000), '约 3 天')
  // 没有 / 非法值不能崩，也不能显示 NaN
  assert.equal(humanizeWait(undefined), '')
  assert.equal(humanizeWait(0), '')
  assert.equal(humanizeWait(-5), '')
  assert.equal(humanizeWait(Number.NaN), '')
})

test('常见失败各自给出对得上的中文做法', () => {
  // 密钥无效 → 去改 key，不是「稍后重试」
  const auth = describeFailure({ type: 'provider.auth', message: 'Invalid API key', status: 401 })
  assert.equal(auth.kind, 'auth')
  assert.match(auth.hint, /API Key|密钥/)

  // 模型没了 → 换模型
  const gone = describeFailure({ type: 'provider', message: 'Model not found' })
  assert.equal(gone.kind, 'model-missing')
  assert.match(gone.hint, /换一个/)

  // 上下文超限 → 开新会话
  const ctx = describeFailure({ message: 'context length exceeded' })
  assert.equal(ctx.kind, 'context')
  assert.match(ctx.hint, /新会话|压缩/)

  // 余额不足 → 去充值
  const quota = describeFailure({ message: 'Insufficient balance' })
  assert.equal(quota.kind, 'quota')
  assert.match(quota.hint, /充值/)

  // 网络 → 检查网络
  const net = describeFailure({ message: 'fetch failed' })
  assert.equal(net.kind, 'network')
  assert.match(net.hint, /网络/)
})

test('判定顺序：免费额度必须排在普通 429 限流前面', () => {
  // 两者都可能带 status 429，但结论完全不同（等十几小时 vs 稍等几秒）
  const free = describeFailure({ type: 'provider.free-limit', message: 'x', status: 429 })
  const rate = describeFailure({ type: 'provider.rate-limit', message: 'x', status: 429 })
  assert.equal(free.kind, 'free-limit')
  assert.equal(rate.kind, 'rate-limit')
  assert.notEqual(free.hint, rate.hint)
})

test('什么都不给时也不崩，给一句能看的兜底', () => {
  const text = describeFailure(null)
  assert.equal(text.kind, 'unknown')
  assert.ok(text.title.length > 0)
  assert.ok(text.hint.length > 0)
  assert.ok(text.raw.length > 0)

  const empty = describeFailure({})
  assert.equal(empty.kind, 'unknown')
  assert.match(empty.raw, /没有给出原因/)
})
