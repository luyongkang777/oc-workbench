// 用量页文案与图表计算的回归。
// node --experimental-strip-types --test scripts/usageFormat.test.mjs
//
// 这类最容易出的错：把未计价调用按 0 元算（费用看起来偏低）、
// 缓存命中率的分母算错（把 input 当成整个提示词）、柱子高度除零、
// 峰值在「没有数据」时编出一个 1、Token 含不含缓存的口径搞混。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  barHeight,
  barTitle,
  formatCost,
  formatPercent,
  formatUsageTokens,
  hitRateOf,
  labelStep,
  outputShare,
  pointValue,
  requestNote,
  seriesPeak,
  sourceName,
  tokensOf,
} from '../src/components/usageFormat.ts'

const totals = (over = {}) => ({
  calls: 10,
  errors: 0,
  retried: 0,
  canceled: 0,
  input: 1000,
  output: 500,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  cost: 1,
  unpriced: 0,
  ...over,
})

const point = (over = {}) => ({
  label: '10',
  time: '2026-11-16',
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  calls: 2,
  cost: 0.5,
  ...over,
})

test('Token 缩写：大数不带小数点', () => {
  assert.equal(formatUsageTokens(0), '0')
  assert.equal(formatUsageTokens(-5), '0')
  assert.equal(formatUsageTokens(999), '999')
  assert.equal(formatUsageTokens(3900), '3.9K')
  assert.equal(formatUsageTokens(39_000), '39K')
  assert.equal(formatUsageTokens(2_200_000), '2.2M')
  assert.equal(formatUsageTokens(956_123_456), '956M')
  assert.equal(formatUsageTokens(1_200_000_000), '1.2B')
})

test('费用：小额多给几位，0 元显示 $0', () => {
  assert.equal(formatCost(0), '$0')
  assert.equal(formatCost(-1), '$0')
  assert.equal(formatCost(0.0003), '$0.0003')
  assert.equal(formatCost(10.356), '$10.36')
})

test('Token 总数：含缓存 / 不含缓存两种口径', () => {
  const t = totals({ input: 1000, output: 500, cacheRead: 2000, cacheWrite: 300 })
  assert.equal(tokensOf(t, false), 1500)
  // 含缓存 = 输入 + 输出 + 缓存读 + 缓存写（magpie 面板的默认口径）
  assert.equal(tokensOf(t, true), 3800)
})

test('缓存命中率：分母是整个提示词（含写入），没有提示词时给 null', () => {
  assert.equal(formatPercent(null), '—')
  assert.equal(formatPercent(0.9714), '97%')
  // input 已经排除了缓存，所以分母 = input + cacheRead + cacheWrite
  assert.equal(hitRateOf(totals({ input: 1500, cacheRead: 2000, cacheWrite: 0 })), 2000 / 3500)
  // 写入算进提示词：不算的话「每轮都重写缓存」会显示接近 100%
  assert.equal(hitRateOf(totals({ input: 1000, cacheRead: 1000, cacheWrite: 1000 })), 1 / 3)
  assert.equal(hitRateOf(totals({ input: 0, cacheRead: 0, cacheWrite: 0 })), null)
})

test('请求提示：失败 / 重试 / 取消 / 未计价', () => {
  assert.equal(requestNote(totals()), '')
  assert.equal(
    requestNote(totals({ errors: 3, retried: 25, canceled: 1, unpriced: 2 })),
    '3 次失败 · 25 次重试后成功 · 1 次取消 · 2 次未计价',
  )
})

test('分组名称：本地会话 / 服务商显示名', () => {
  assert.equal(sourceName('opencode', 'agent'), '本地会话')
  assert.equal(sourceName('deepseek', 'provider'), 'DeepSeek')
  assert.equal(sourceName('unknown-provider', 'provider'), 'unknown-provider')
  assert.equal(sourceName('', 'agent'), '未知')
})

test('图表：峰值在无数据时是 0（界面显示「峰值 —」）', () => {
  const points = [point({ label: '00', input: 100, output: 50 }), point({ label: '01', input: 0, output: 0, calls: 0 })]
  assert.equal(seriesPeak(points, 'token', false), 150)
  // 含缓存时总量更大
  assert.equal(seriesPeak([point({ input: 100, output: 50, cacheRead: 1000 })], 'token', true), 1150)
  // 所有桶都为 0：返回 0，不能编一个 1
  assert.equal(seriesPeak([points[1]], 'calls', false), 0)
  assert.equal(pointValue(points[0], 'calls', false), 2)
})

test('图表：柱子高度与输出占比', () => {
  assert.equal(barHeight(point(), 'token', 150, false), 100)
  assert.equal(barHeight(point({ input: 0, output: 0 }), 'token', 150, false), 0)
  // 有值的最小 1.5%，否则空柱看不见
  assert.equal(barHeight(point({ input: 1, output: 0 }), 'token', 1_000_000, false), 1.5)
  assert.equal(outputShare(point(), 'token', false).toFixed(2), '0.33')
  // 含缓存时输出占比变小（缓存占了柱子的绝大部分）
  assert.equal(outputShare(point({ cacheRead: 850 }), 'token', true).toFixed(2), '0.05')
  // 非 token 指标不分段
  assert.equal(outputShare(point(), 'cost', false), 0)
})

test('柱子悬停文案（含缓存口径）', () => {
  assert.equal(barTitle(point(), 'hour', false), '10:00 · 150 tokens · 2 次请求 · $0.50')
  assert.equal(barTitle(point({ cacheRead: 1000 }), 'day', true), '2026-11-16 · 1.1K tokens · 2 次请求 · $0.50')
  assert.equal(barTitle(point({ calls: 0 }), 'day', false), '2026-11-16 · 没有请求')
})

test('X 轴标签抽稀步长', () => {
  assert.equal(labelStep(24), 4)
  assert.equal(labelStep(7), 1)
  assert.equal(labelStep(60), 12)
})
