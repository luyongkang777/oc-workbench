// 对话断线重试策略的回归：node --experimental-strip-types --test scripts/retryPolicy.test.mjs
//
// 这段策略坏了有三种表现，都很难在界面上看出来：
//   1. 次数被收敛到 3 次以下 → 扛不住一次抖动，用户仍然看到对话断掉；
//   2. 把「模型不存在」也重试 → 白白拖 5 次，输入框一直转；
//   3. 退避没有上限 → 服务端给一个离谱的 retryAfterMs，界面挂十分钟。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_RETRY_ATTEMPTS,
  MAX_RETRY_ATTEMPTS,
  MIN_RETRY_ATTEMPTS,
  isRetryableError,
  isRetryableFailure,
  isRetryableText,
  normalizeRetryAttempts,
  retryAfterOf,
  retryDelay,
  retryGiveUpText,
  retryNoticeText,
  shouldGiveUp,
} from '../src/components/retryPolicy.ts'

test('重试次数落在 3~8 之间，非法值退回默认', () => {
  assert.ok(MIN_RETRY_ATTEMPTS === 3 && MAX_RETRY_ATTEMPTS === 8)
  assert.ok(DEFAULT_RETRY_ATTEMPTS >= MIN_RETRY_ATTEMPTS)
  assert.ok(DEFAULT_RETRY_ATTEMPTS <= MAX_RETRY_ATTEMPTS)
  assert.equal(normalizeRetryAttempts(1), 3)
  assert.equal(normalizeRetryAttempts(20), 8)
  assert.equal(normalizeRetryAttempts(6), 6)
  assert.equal(normalizeRetryAttempts('4'), 4)
  for (const bad of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 'abc', {}]) {
    assert.equal(normalizeRetryAttempts(bad), DEFAULT_RETRY_ATTEMPTS)
  }
})

test('退避递增、有封顶，且尊重服务端的 retryAfterMs', () => {
  const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => retryDelay(n))
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(delays[i] >= delays[i - 1], `第 ${i} 次不应更短：${delays}`)
  }
  assert.ok(delays[0] >= 500, '第一次别贴着重试，至少 0.5 秒')
  assert.equal(delays.at(-1), 8_000, '单次等待封顶 8 秒')

  // 服务端给的等待更长时用它，但也要封顶
  assert.equal(retryDelay(1, 3_000), 3_000)
  assert.equal(retryDelay(1, 999_999), 30_000)
  // 服务端给的比退避还短时，仍按退避走（别一秒打几十次）
  assert.ok(retryDelay(3, 10) >= 3_000)
})

test('网络抖动可重试，配置类错误不重试', () => {
  const retry = [
    'fetch failed',
    'Failed to fetch',
    'ECONNRESET',
    '请求超时',
    '503 Service Unavailable',
    '429 Too Many Requests',
    '502 bad gateway',
    '事件流连接失败：401',
    'socket hang up',
  ]
  for (const text of retry) {
    assert.equal(isRetryableText(text), true, `应重试：${text}`)
  }

  const permanent = [
    'Model unavailable: does-not-exist/nope-1',
    '400 Invalid request',
    '401 Unauthorized',
    '403 Forbidden',
    '404 Session not found',
    'unsupported model: foo',
    'content-filter',
  ]
  for (const text of permanent) {
    assert.equal(isRetryableText(text), false, `不该重试：${text}`)
  }

  assert.equal(isRetryableText(''), false)
  assert.equal(isRetryableText('   '), false)
})

test('结构化错误优先看 status，其次看 type/message', () => {
  assert.equal(isRetryableFailure({ type: 'provider.rate_limit', status: 429 }), true)
  assert.equal(isRetryableFailure({ type: 'provider.no-route', message: 'Model unavailable' }), false)
  assert.equal(isRetryableFailure({ type: 'unknown', status: 500 }), true)
  assert.equal(isRetryableFailure({ type: 'unknown', status: 400 }), false)
  assert.equal(isRetryableFailure({ message: 'overloaded' }), true)
  assert.equal(isRetryableFailure(null), false)
  assert.equal(isRetryableFailure(undefined), false)
  // 有 5xx 状态码但文案明确是「模型不存在」时，仍判死
  assert.equal(
    isRetryableFailure({ status: 503, message: 'Model unavailable: x/y' }),
    false,
  )
})

test('isRetryableError 能吃 Error / 字符串 / 未知值', () => {
  assert.equal(isRetryableError(new Error('fetch failed')), true)
  assert.equal(isRetryableError('ECONNRESET'), true)
  assert.equal(isRetryableError(new Error('401 Unauthorized')), false)
  assert.equal(isRetryableError(null), false)
  assert.equal(isRetryableError(undefined), false)
})

test('retryAfterOf 只认有限正数', () => {
  assert.equal(retryAfterOf({ retryAfterMs: 1500 }), 1500)
  assert.equal(retryAfterOf({ retryAfterMs: 0 }), undefined)
  assert.equal(retryAfterOf({ retryAfterMs: -1 }), undefined)
  assert.equal(retryAfterOf({ retryAfterMs: Number.NaN }), undefined)
  assert.equal(retryAfterOf({}), undefined)
  assert.equal(retryAfterOf(null), undefined)
})

test('到上限才放弃：允许真的重试满 maxAttempts 次', () => {
  // 失败 3 次 = 已经重试 2 次，还能再重试一次
  assert.equal(shouldGiveUp(3, 3), false)
  // 失败 4 次 = 已经重试 3 次，到上限，放弃
  assert.equal(shouldGiveUp(4, 3), true)
  // 传 100 次也被收敛到 8：失败 8 次还能再试一次，9 次放弃
  assert.equal(shouldGiveUp(8, 100), false)
  assert.equal(shouldGiveUp(9, 100), true)
  // 传 1 次被抬到 3：不许把重试关掉
  assert.equal(shouldGiveUp(3, 1), false)
  assert.equal(shouldGiveUp(4, 1), true)
})

test('提示文案带进度与真实原因', () => {
  assert.match(retryNoticeText(2, 5), /2\/5/)
  assert.match(retryNoticeText(9, 5), /5\/5/, '超过上限时最多显示 max/max')
  const giveUp = retryGiveUpText(5, 5, '503 Service Unavailable')
  assert.match(giveUp, /5 次/)
  assert.match(giveUp, /503/)
  assert.match(retryGiveUpText(1, 1, ''), /没有拿到具体原因/)
})
