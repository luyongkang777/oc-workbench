// 会话统计的回归测试：node --experimental-strip-types --test scripts/sessionStats.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activitySummary,
  computeSessionStats,
  countsLabel,
  emptyStats,
  estimateTextTokens,
  formatPercent,
  formatRate,
  formatStatSpan,
  formatTokenTotal,
  usageSummary,
} from '../src/components/sessionStats.ts'

const user = (created = 1, text = '问题') => ({
  id: `u${created}`,
  type: 'user',
  text,
  time: { created },
})

const assistant = (id, content, tokens, time) => ({
  id,
  type: 'assistant',
  content,
  tokens,
  time,
})

const text = (value, created) => ({ type: 'text', text: value, time: created ? { created } : undefined })

test('空列表给出全零且 known=false', () => {
  const stats = computeSessionStats([], 1000)
  assert.equal(stats.turns, 0)
  assert.equal(stats.steps, 0)
  assert.equal(stats.total, 0)
  assert.equal(stats.cacheHit, null)
  assert.equal(stats.tps, null)
  assert.equal(stats.ttftMs, null)
  assert.equal(stats.known, false)
})

test('轮数与步数：一条用户消息带三步工具调用', () => {
  const messages = [
    assistant('a3', [text('done', 1300)], { input: 10, output: 20 }, { created: 1200, completed: 1400 }),
    assistant('a2', [{ type: 'tool', name: 'bash', state: { status: 'completed' } }], { input: 10, output: 5 }, { created: 1100, completed: 1200 }),
    assistant('a1', [text('开始', 1050)], { input: 10, output: 15 }, { created: 1000, completed: 1100 }),
    user(900),
  ]
  const stats = computeSessionStats(messages, 2000)
  assert.equal(stats.turns, 1)
  assert.equal(stats.steps, 3)
  assert.equal(countsLabel(stats), '1 轮 3 步')
})

test('step 一开始骨架就算一步，读数不用等结束才动', () => {
  const messages = [assistant('a1', [], undefined, { created: 100 }), user(50)]
  const stats = computeSessionStats(messages, 200)
  assert.equal(stats.steps, 1)
})

test('连开始时间都没有的空消息不算一步', () => {
  const messages = [assistant('a1', [], undefined, undefined), user(50)]
  const stats = computeSessionStats(messages, 200)
  assert.equal(stats.steps, 0)
})

test('流式中没有 tokens 时按已落地文字估算输出，中文 1 字 1 token', () => {
  const messages = [
    assistant('a1', [text('你好世界', 1100)], undefined, { created: 1000 }),
    user(900),
  ]
  const stats = computeSessionStats(messages, 2000)
  assert.equal(stats.output, 4)
  assert.equal(stats.running, true)
  // 1000 → 2000 里真正在写的是 1100 → 2000（900ms），4 token ≈ 4.4 tok/s
  assert.ok(stats.tps !== null && Math.abs(stats.tps - 4.44) < 0.01, `tps=${stats.tps}`)
})

test('这一步跑完拿到真实 tokens 后，估算值被整体替换', () => {
  const streaming = [assistant('a1', [text('你好世界', 1100)], undefined, { created: 1000 }), user(900)]
  const finished = [
    assistant('a1', [text('你好世界', 1100)], { input: 10, output: 27 }, { created: 1000, completed: 2000 }),
    user(900),
  ]
  assert.equal(computeSessionStats(streaming, 2000).output, 4)
  assert.equal(computeSessionStats(finished, 2000).output, 27)
})

test('估算：中文按字算，英文按 4 字符一个 token', () => {
  assert.equal(estimateTextTokens('你好'), 2)
  assert.equal(estimateTextTokens('hello world'), 3)
  assert.equal(estimateTextTokens(''), 0)
})

test('缓存命中率的分母包含缓存读：全命中缓存不等于 0%', () => {
  const stats = computeSessionStats(
    [
      assistant('a1', [text('x', 1100)], { input: 100, output: 50, cache: { read: 900, write: 0 } }, { created: 1000, completed: 1200 }),
      user(900),
    ],
    1300,
  )
  assert.equal(stats.cacheRead, 900)
  // 900 / (100 + 900 + 0) = 90%
  assert.equal(Math.round(stats.cacheHit), 90)
})

test('完全没有输入侧 token 时命中率为 null，不显示成 0% 或 NaN', () => {
  const stats = computeSessionStats(
    [assistant('a1', [text('x', 1100)], { output: 50 }, { created: 1000, completed: 1200 }), user(900)],
    1300,
  )
  assert.equal(stats.cacheHit, null)
  assert.equal(formatPercent(stats.cacheHit), '')
})

test('输出速度只除以生成时间，工具等待不摊薄速度', () => {
  // 第一轮：created → 首个文本 0ms(TTFT 200)，生成 800ms，输出 400 token → 500 tok/s
  const messages = [
    assistant(
      'a1',
      [text('正文', 1200)],
      { input: 0, output: 400, cache: { read: 100, write: 0 } },
      { created: 1000, completed: 2000 },
    ),
    user(900),
  ]
  const stats = computeSessionStats(messages, 3000)
  assert.equal(stats.ttftMs, 200)
  assert.equal(stats.tps, 500)
  // 模型用时 = TTFT + 生成时间
  assert.equal(stats.modelMs, 1000)
})

test('工具耗时按 tool part 的执行区间累计', () => {
  const messages = [
    assistant(
      'a1',
      [
        text('查一下', 1100),
        { type: 'tool', name: 'bash', state: { status: 'completed', time: { start: 1200, end: 1700 } } },
        { type: 'tool', name: 'read', state: { status: 'completed', time: { start: 1800, end: 2000 } } },
      ],
      { input: 10, output: 20 },
      { created: 1000, completed: 2100 },
    ),
    user(900),
  ]
  const stats = computeSessionStats(messages, 2200)
  assert.equal(stats.toolMs, 700)
})

test('还在跑的 step 标 running，且用 now 估算生成时间', () => {
  const messages = [
    assistant('a1', [text('写到一半', 1200)], { input: 0, output: 100 }, { created: 1000 }),
    user(900),
  ]
  const stats = computeSessionStats(messages, 2200)
  assert.equal(stats.running, true)
  // 1200 → 2200 = 1000ms，100 token → 100 tok/s
  assert.equal(stats.tps, 100)
})

test('TTFT 只统计有内容段时间戳的 step，纯工具步骤不拉低平均', () => {
  const messages = [
    assistant('a2', [text('a', 3000)], { input: 1, output: 1 }, { created: 2900, completed: 3100 }),
    // 纯工具步骤：没有 text/reasoning 时间戳，不应贡献 ttft
    assistant('a1', [{ type: 'tool', name: 'bash', state: { status: 'completed' } }], { input: 1, output: 1 }, { created: 1000, completed: 2000 }),
    user(900),
  ]
  const stats = computeSessionStats(messages, 3200)
  assert.equal(stats.ttftMs, 100)
})

test('总 token 把输入、输出、缓存读写都算进去', () => {
  const stats = computeSessionStats(
    [
      assistant('a1', [text('x', 1100)], { input: 100, output: 50, reasoning: 20, cache: { read: 300, write: 40 } }, { created: 1000, completed: 1200 }),
      user(900),
    ],
    1300,
  )
  assert.equal(stats.total, 490)
  assert.equal(stats.reasoning, 20)
})

test('读数在第一段为空时省略，不显示占位符', () => {
  const stats = { ...emptyStats(), turns: 1, steps: 2 }
  assert.equal(activitySummary(stats), '1 轮 2 步')
  assert.equal(usageSummary(stats, '0'), '0 tok')
})

test('读数拼装：轮/步 · 速度，token · 命中率', () => {
  const stats = {
    ...emptyStats(),
    turns: 1,
    steps: 4,
    total: 38_300,
    cacheHit: 67,
    tps: 218,
  }
  assert.equal(activitySummary(stats), '1 轮 4 步 · 218 tok/s')
  assert.equal(usageSummary(stats, '38k'), '38k tok · 缓存命中 67%')
})

test('速度只看本轮：历史几百步不会把读数摊成不动', () => {
  const messages = [
    // 本轮：100 token / 1000ms = 100 tok/s
    assistant('a_new', [text('这轮', 1000)], { input: 0, output: 100 }, { created: 1000, completed: 2000 }),
    user(900),
    // 历史轮：10 万 token，若按会话累计，速度会被摊到原来的千分之一
    assistant('h1', [text('历史', 100)], { input: 0, output: 100_000 }, { created: 0, completed: 100_000 }),
    user(0),
  ]
  const stats = computeSessionStats(messages, 2500)
  assert.equal(stats.tps, 100)
  assert.equal(stats.output, 100_100)
  assert.equal(stats.turnOutput, 100)
  assert.equal(stats.turnSteps, 1)
})

test('服务端给了 output: 0 但已有文字时照样走估算', () => {
  const messages = [
    assistant('a1', [text('你好世界', 1100)], { input: 5, output: 0 }, { created: 1000 }),
    user(900),
  ]
  assert.equal(computeSessionStats(messages, 2000).output, 4)
})

test('工具执行时间从生成时间里扣掉，速度不被工具等待摊薄', () => {
  const messages = [
    assistant(
      'a1',
      [
        text('先说一句', 1200),
        { type: 'tool', name: 'bash', state: { status: 'completed', time: { start: 2000, end: 32_000 } } },
        text('再说一句', 33_000),
      ],
      { input: 0, output: 400 },
      { created: 1000, completed: 40_000 },
    ),
    user(900),
  ]
  const stats = computeSessionStats(messages, 41_000)
  // 40 秒墙钟里工具占了 30 秒，真正在写的是 1200→40000 减去 30000 = 8.8 秒
  assert.equal(stats.toolMs, 30_000)
  assert.ok(Math.abs(stats.tps - 400 / 8.8) < 0.1, `tps=${stats.tps}`)
})

test('纯工具步骤不参与计速，不会把速度拖到个位数', () => {
  const messages = [
    // 这一轮：先一个 30 秒的纯工具步，再一步写 200 token 用 1 秒
    assistant('a_text', [text('写', 32_000)], { input: 5, output: 200 }, { created: 31_000, completed: 33_000 }),
    assistant(
      'a_tool',
      [{ type: 'tool', name: 'bash', state: { status: 'completed', time: { start: 1000, end: 31_000 } } }],
      { input: 5, output: 0 },
      { created: 1000, completed: 31_000 },
    ),
    user(900),
  ]
  const stats = computeSessionStats(messages, 34_000)
  // 只有带文字那一步参与：200 / 1s = 200 tok/s
  assert.equal(stats.tps, 200)
  assert.equal(stats.toolMs, 30_000)
})

test('还在跑的工具已经占掉的时间，也从生成时间里扣', () => {
  const messages = [
    assistant(
      'a1',
      [
        text('开始跑', 1200),
        { type: 'tool', name: 'shell', state: { status: 'running', time: { start: 2000 } } },
      ],
      { input: 0, output: 100 },
      { created: 1000 },
    ),
    user(900),
  ]
  const stats = computeSessionStats(messages, 32_000)
  // now - firstAt = 30800ms，工具已经跑了 30000ms，剩下 800ms 才是模型在写
  assert.ok(Math.abs(stats.tps - 100 / 0.8) < 1, `tps=${stats.tps}`)
})

test('工具时间读 part.time（实测结构），不是 state.time', () => {
  const messages = [
    assistant(
      'a1',
      [
        text('先跑个命令', 1200),
        // 实测：created（发起）→ ran（开始执行）→ completed（结束）
        { type: 'tool', name: 'shell', time: { created: 1300, ran: 1500, completed: 3300 } },
      ],
      { input: 0, output: 200 },
      { created: 1000, streamed: 4000, completed: 4200 },
    ),
    user(900),
  ]
  const stats = computeSessionStats(messages, 5000)
  assert.equal(stats.toolMs, 2000)
  // 生成时间 = 1200 → streamed(4000) 扣掉工具 1300→3300（与区间重叠 1300→3300）
  // = 2800 - 2000 = 800ms → 200 / 0.8 = 250 tok/s
  assert.ok(Math.abs(stats.tps - 250) < 1, `tps=${stats.tps}`)
})

test('用 streamed 当终点：streamed 之后才跑的工具不占生成时间', () => {
  const messages = [
    assistant(
      'a1',
      [
        text('写完了', 1200),
        // 工具在 streamed（10000）之后才开始执行，占 50 秒
        { type: 'tool', name: 'shell', time: { created: 10_500, ran: 10_600, completed: 60_000 } },
      ],
      { input: 0, output: 500 },
      { created: 1000, streamed: 10_000, completed: 60_000 },
    ),
    user(900),
  ]
  const stats = computeSessionStats(messages, 61_000)
  assert.equal(stats.toolMs, 49_500)
  // 生成时间只算 1200 → 10000 = 8.8 秒，工具一毫秒都不占
  assert.ok(Math.abs(stats.tps - 500 / 8.8) < 0.5, `tps=${stats.tps}`)
})

test('思考 token 计入速度：推理模型一步里思考远多于正文', () => {
  const messages = [
    assistant(
      'a1',
      [{ type: 'reasoning', text: '想了很久', time: { created: 1200, completed: 10_000 } }],
      { input: 500, output: 200, reasoning: 4000 },
      { created: 1000, streamed: 10_200, completed: 10_300 },
    ),
    user(900),
  ]
  const stats = computeSessionStats(messages, 11_000)
  assert.equal(stats.turnOutput, 200)
  assert.equal(stats.turnReasoning, 4000)
  // (200 + 4000) / 9.0s（1200 → 10200）= 466.7
  assert.ok(Math.abs(stats.tps - 4200 / 9) < 1, `tps=${stats.tps}`)
})

test('formatStatSpan 分档：毫秒 / 秒 / 分 / 小时', () => {
  assert.equal(formatStatSpan(0), '—')
  assert.equal(formatStatSpan(420), '420ms')
  assert.equal(formatStatSpan(4200), '4.2s')
  assert.equal(formatStatSpan(72_000), '1分12秒')
  assert.equal(formatStatSpan(63 * 60_000), '1小时3分')
})

test('formatRate 小数值保留一位，大数值取整', () => {
  assert.equal(formatRate(null), '')
  assert.equal(formatRate(0), '')
  assert.equal(formatRate(12.34), '12.3 tok/s')
  assert.equal(formatRate(218.4), '218 tok/s')
})

test('formatTokenTotal 保留一位小数，38.3k 不被压成 38k', () => {
  assert.equal(formatTokenTotal(0), '0')
  assert.equal(formatTokenTotal(532), '532')
  assert.equal(formatTokenTotal(3830), '3.8k')
  assert.equal(formatTokenTotal(38_300), '38.3k')
  assert.equal(formatTokenTotal(393_000), '393k')
  assert.equal(formatTokenTotal(4_100_000), '4.1M')
})
