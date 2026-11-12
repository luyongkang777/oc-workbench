// 上下文用量的回归测试：node --experimental-strip-types --test scripts/contextUsage.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computeContextUsage,
  contextHint,
  emptyUsage,
  formatTokens,
  usageTone,
} from '../src/components/contextUsage.ts'

const assistant = (tokens, created = 1) => ({ id: `a${created}`, type: 'assistant', tokens, time: { created } })
const user = (created = 2) => ({ id: `u${created}`, type: 'user', text: 'x', time: { created } })

test('formatTokens 按 k/M 缩写，去掉多余的 .0', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(532), '532')
  assert.equal(formatTokens(1200), '1.2k')
  assert.equal(formatTokens(169_000), '169k')
  assert.equal(formatTokens(1_048_576), '1M')
  assert.equal(formatTokens(1_200_000), '1.2M')
})

test('上下文用量把 input 与 cache.read 相加，不只看 input', () => {
  const messages = [
    assistant({ input: 900, output: 1000, cache: { read: 560_000, write: 0 } }, 10),
    user(9),
    assistant({ input: 300, output: 10, cache: { read: 1000, write: 0 } }, 8),
  ]
  const usage = computeContextUsage(messages, 1_048_576)
  assert.equal(usage.used, 900 + 1000 + 560_000)
  assert.equal(usage.cacheRead, 560_000)
  assert.equal(Math.round(usage.percent), 54)
  assert.equal(usage.known, true)
})

test('取最近一次调用的 tokens（最新在前），不是全部累加', () => {
  const messages = [
    assistant({ input: 100, output: 0 }, 30),
    user(20),
    assistant({ input: 999_999, output: 0 }, 10),
  ]
  assert.equal(computeContextUsage(messages, 1000).used, 100)
})

test('没有 tokens 时返回 known=false 与 0 百分比的占位', () => {
  const usage = computeContextUsage([user(1)], 1_000_000)
  assert.equal(usage.known, false)
  assert.equal(usage.percent, 0)
  assert.equal(usage.limit, 1_000_000)
  assert.deepEqual(computeContextUsage([], 0), emptyUsage(0))
})

test('上限未知时不显示百分比但保留已用量', () => {
  const usage = computeContextUsage([assistant({ input: 5000, cache: { read: 5000 } })], 0)
  assert.equal(usage.limit, 0)
  assert.equal(usage.percent, 0)
  assert.match(contextHint(usage), /模型上限未知/)
  assert.match(contextHint(usage), /已用 10k/)
})

test('百分比封顶 100，档位随占用变化', () => {
  const over = computeContextUsage([assistant({ input: 2_000_000 })], 1_000_000)
  assert.equal(over.percent, 100)
  assert.equal(usageTone(over), 'danger')
  assert.equal(usageTone(computeContextUsage([assistant({ input: 500_000 })], 1_000_000)), 'ok')
  assert.equal(usageTone(computeContextUsage([assistant({ input: 750_000 })], 1_000_000)), 'warn')
  assert.equal(usageTone(emptyUsage(1_000_000)), 'idle')
})

test('提示文案与截图口径一致', () => {
  const usage = computeContextUsage([assistant({ input: 900, cache: { read: 168_000 } })], 1_048_576)
  assert.match(contextHint(usage), /^已用上下文长度：16%（已用 169k，共 1M）$/)
})

test('压缩刚完成时按摘要本身算，不用压缩那次调用读进去的旧上下文', () => {
  const compaction = {
    id: 'msg_c',
    type: 'compaction',
    summary: '## Objective\n- 摘要',
    tokens: { input: 427_710, output: 2_500, cache: { read: 34_816 } },
  }
  const usage = computeContextUsage([compaction, assistant({ input: 400_000 }, 1)], 1_000_000)
  // input/cache 是压缩前那一大坨历史；拿它算会得出「461k → 461k」这种假数字
  assert.equal(usage.used, 2_500)
  assert.equal(usage.output, 2_500)
  assert.equal(usage.cacheRead, 0)
  assert.equal(usage.known, true)
  assert.ok(usage.percent < 1)
})

test('压缩消息没有 tokens 时给占位，不回退到更早的 assistant 用量', () => {
  const usage = computeContextUsage(
    [{ id: 'msg_c', type: 'compaction', summary: '摘要' }, assistant({ input: 400_000 }, 1)],
    1_000_000,
  )
  assert.equal(usage.known, false)
  assert.equal(usage.used, 0)
})
