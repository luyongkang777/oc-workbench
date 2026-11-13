/**
 * 子智能体面板逻辑测试。
 *
 *   npm test   （或 node --experimental-strip-types --test scripts/subagent.test.mjs）
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  STUCK_MS,
  buildSubagentRows,
  elapsedOf,
  fmtCost,
  fmtElapsed,
  fmtTokens,
  inTokensOf,
  isExpanded,
  isStuck,
  parseSubagentMode,
  outTokensOf,
  pickActivity,
  shortID,
  stateMark,
  stateOf,
  summarize,
  summarizeInput,
} from '../src/components/subagent.ts'

// ---------------------------------------------------------------- 状态

test('stateOf: busy 比 idle 新 = 在跑', () => {
  assert.equal(stateOf({ id: 'a', time: { busy: 200, idle: 100 } }, 1000), 'running')
})

test('stateOf: outcome 优先于时间戳', () => {
  const session = { id: 'a', time: { busy: 100, idle: 200 }, outcome: 'failed' }
  assert.equal(stateOf(session, 1000), 'failed')
})

test('stateOf: 没有 outcome 也不算成功', () => {
  assert.equal(stateOf({ id: 'a', time: { busy: 100, idle: 200 } }, 1000), 'idle')
})

test('stateOf: 三种结局都能识别', () => {
  const base = { id: 'a', time: { busy: 100, idle: 200 } }
  assert.equal(stateOf({ ...base, outcome: 'succeeded' }, 1000), 'succeeded')
  assert.equal(stateOf({ ...base, outcome: 'failed' }, 1000), 'failed')
  assert.equal(stateOf({ ...base, outcome: 'interrupted' }, 1000), 'interrupted')
})

test('stateMark: 五种状态各一个符号', () => {
  assert.equal(stateMark('running'), '▶')
  assert.equal(stateMark('succeeded'), '✓')
  assert.equal(stateMark('failed'), '✕')
  assert.equal(stateMark('interrupted'), '■')
  assert.equal(stateMark('idle'), '·')
})

// ---------------------------------------------------------------- 耗时

test('elapsedOf: 跑动中按 now - busy 算', () => {
  const session = { id: 'a', time: { busy: 1000, created: 500 } }
  assert.equal(elapsedOf(session, 6000), 5000)
})

test('elapsedOf: 已结束按 idle - busy 算', () => {
  const session = { id: 'a', time: { busy: 1000, idle: 4000 } }
  assert.equal(elapsedOf(session, 99_999), 3000)
})

test('elapsedOf: 没有 busy 就退回 created', () => {
  const session = { id: 'a', time: { created: 1000, idle: 3000 } }
  assert.equal(elapsedOf(session, 99_999), 2000)
})

test('elapsedOf: 负数夹成 0', () => {
  assert.equal(elapsedOf({ id: 'a', time: { busy: 5000, idle: 4000 } }, 6000), 1000)
  assert.equal(elapsedOf({ id: 'a', time: { busy: 5000, idle: 5000 } }, 6000) >= 0, true)
})

// ---------------------------------------------------------------- token

test('outTokensOf: output + reasoning', () => {
  assert.equal(outTokensOf({ id: 'a', tokens: { output: 100, reasoning: 50 } }), 150)
})

test('inTokensOf: input + cache.read（不能只看 input）', () => {
  assert.equal(inTokensOf({ id: 'a', tokens: { input: 100, cache: { read: 900 } } }), 1000)
})

test('token 函数缺字段返回 0', () => {
  assert.equal(outTokensOf({ id: 'a' }), 0)
  assert.equal(inTokensOf({ id: 'a' }), 0)
})

// ---------------------------------------------------------------- 活动

test('summarizeInput: 按优先级挑', () => {
  assert.equal(summarizeInput({ command: 'ls', filePath: 'x' }), 'ls')
  assert.equal(summarizeInput({ filePath: 'x' }), 'x')
  assert.equal(summarizeInput({}), '')
  assert.equal(summarizeInput(undefined), '')
})

test('pickActivity: 取最后一条 assistant 的工具', () => {
  const activity = pickActivity([
    {
      type: 'assistant',
      content: [
        { type: 'text', text: '先看看' },
        { type: 'tool', name: 'read', state: { input: { filePath: 'F:\\a.ts' } } },
      ],
    },
  ])
  assert.equal(activity.tool, 'read')
  assert.equal(activity.detail, 'F:\\a.ts')
})

test('pickActivity: 没有工具就取文本', () => {
  const activity = pickActivity([{ type: 'assistant', content: [{ type: 'text', text: '结论' }] }])
  assert.equal(activity.tool, '')
  assert.equal(activity.detail, '结论')
})

test('pickActivity: 跳过 user 消息', () => {
  const activity = pickActivity([
    { type: 'assistant', content: [{ type: 'text', text: '我的结论' }] },
    { type: 'user', content: [{ type: 'text', text: '用户的话' }] },
  ])
  assert.equal(activity.detail, '我的结论')
})

test('pickActivity: 空/坏输入不炸', () => {
  assert.deepEqual(pickActivity([]), { tool: '', detail: '' })
  assert.deepEqual(pickActivity(undefined), { tool: '', detail: '' })
  assert.deepEqual(pickActivity([{ type: 'assistant' }]), { tool: '', detail: '' })
})

// ---------------------------------------------------------------- 行构建

const sessions = [
  { id: 'ses_C1_bbbbbb', title: '找文件', agent: 'explore', depth: 1, time: { busy: 1000, idle: 5000 }, outcome: 'succeeded', tokens: { output: 500 }, cost: 0.01 },
  { id: 'ses_C2_cccccc', title: '查崩溃', agent: 'debug', depth: 1, time: { busy: 2000 }, tokens: { output: 300 } },
  { id: 'ses_G1_dddddd', title: '孙辈', agent: 'general', depth: 2, time: { busy: 3000 } },
]

test('buildSubagentRows: 跑动的排最前', () => {
  const rows = buildSubagentRows({ sessions, now: 10_000 })
  assert.equal(rows[0].state, 'running')
  assert.ok(rows[0].title === '查崩溃' || rows[0].title === '孙辈')
})

test('buildSubagentRows: 都是跑动时久的在前', () => {
  const rows = buildSubagentRows({ sessions, now: 10_000 })
  assert.equal(rows[0].title, '查崩溃') // busy 2000 → 8s，比孙辈的 7s 久
})

test('buildSubagentRows: 保留 depth', () => {
  const rows = buildSubagentRows({ sessions, now: 10_000 })
  assert.equal(rows.find((r) => r.id === 'ses_G1_dddddd')?.depth, 2)
})

test('buildSubagentRows: 缺 title 给默认值', () => {
  const rows = buildSubagentRows({ sessions: [{ id: 'x' }], now: 1 })
  assert.equal(rows[0].title, '（未命名子任务）')
})

test('buildSubagentRows: 带上活动信息', () => {
  const rows = buildSubagentRows({
    sessions: [{ id: 'ses_C2_cccccc', title: 't' }],
    now: 1000,
    activities: { ses_C2_cccccc: { tool: 'bash', detail: 'npm test' } },
  })
  assert.equal(rows[0].tool, 'bash')
  assert.equal(rows[0].detail, 'npm test')
})

test('buildSubagentRows: 空输入返回空数组', () => {
  assert.deepEqual(buildSubagentRows({ sessions: [], now: 1 }), [])
  assert.deepEqual(buildSubagentRows({ sessions: undefined, now: 1 }), [])
})

test('shortID: 取尾部六位', () => {
  assert.equal(shortID('ses_e2b1fc8caffeIXnZ2DY5FBv2sb').length, 6)
})

// ---------------------------------------------------------------- 汇总

test('summarize: 有跑动时报跑/总', () => {
  const rows = buildSubagentRows({ sessions, now: 10_000 })
  const summary = summarize(rows)
  assert.equal(summary.total, 3)
  assert.equal(summary.running, 2)
  assert.match(summary.text, /2 个在跑/)
})

test('summarize: 全结束时说全部结束', () => {
  const rows = buildSubagentRows({
    sessions: [{ id: 'a', time: { busy: 1, idle: 2 }, outcome: 'succeeded' }],
    now: 100,
  })
  assert.match(summarize(rows).text, /全部结束/)
})

test('summarize: 空列表文案为空', () => {
  assert.equal(summarize([]).text, '')
})

test('summarize: 累加 token 和花费', () => {
  const rows = buildSubagentRows({
    sessions: [
      { id: 'a', tokens: { output: 100 }, cost: 0.01 },
      { id: 'b', tokens: { output: 200 }, cost: 0.02 },
    ],
    now: 1,
  })
  const summary = summarize(rows)
  assert.equal(summary.outTokens, 300)
  assert.equal(Math.round(summary.cost * 100) / 100, 0.03)
})

// ---------------------------------------------------------------- 格式化

test('fmtElapsed: 三种量级', () => {
  assert.equal(fmtElapsed(5000), '5s')
  assert.equal(fmtElapsed(65_000), '1m05s')
  assert.equal(fmtElapsed(3_725_000), '1h02m')
  assert.equal(fmtElapsed(-1), '—')
})

test('fmtTokens: 三种量级', () => {
  assert.equal(fmtTokens(0), '0')
  assert.equal(fmtTokens(999), '999')
  assert.equal(fmtTokens(1500), '1.5K')
  assert.equal(fmtTokens(25_000), '25K')
  assert.equal(fmtTokens(2_500_000), '2.5M')
})

test('fmtCost: 小额标 <$0.01', () => {
  assert.equal(fmtCost(0), '')
  assert.equal(fmtCost(0.001), '<$0.01')
  assert.equal(fmtCost(1.5), '$1.50')
})

// ---------------------------------------------------------------- 卡住

test('isStuck: 跑动且超阈值', () => {
  // busy 有值且大于 idle 才算在跑（busy: 0 是「没有 busy 时间戳」，不是运行中）
  const rows = buildSubagentRows({
    sessions: [{ id: 'a', time: { busy: 1000, idle: 0 } }],
    now: 1000 + STUCK_MS + 1000,
  })
  assert.equal(isStuck(rows[0], 1000 + STUCK_MS + 1000), true)
})

test('isStuck: 没超阈值不算', () => {
  const rows = buildSubagentRows({
    sessions: [{ id: 'a', time: { busy: 1000, idle: 0 } }],
    now: 2000,
  })
  assert.equal(isStuck(rows[0], 2000), false)
})

test('isStuck: busy 为 0（没有时间戳）不算在跑', () => {
  const rows = buildSubagentRows({ sessions: [{ id: 'a', time: { busy: 0 } }], now: 999_999 })
  assert.equal(rows[0].state, 'idle')
  assert.equal(isStuck(rows[0], 999_999), false)
})

test('isStuck: 已结束的永远不算卡住', () => {
  const rows = buildSubagentRows({
    sessions: [{ id: 'a', time: { busy: 1, idle: 2 }, outcome: 'succeeded' }],
    now: STUCK_MS * 10,
  })
  assert.equal(isStuck(rows[0], STUCK_MS * 10), false)
})


// ---------------------------------------------------------------- 显示模式

test('parseSubagentMode: 认三种模式和两个老值', () => {
  assert.equal(parseSubagentMode('auto'), 'auto')
  assert.equal(parseSubagentMode('open'), 'open')
  assert.equal(parseSubagentMode('closed'), 'closed')
  assert.equal(parseSubagentMode('1'), 'open')
  assert.equal(parseSubagentMode('0'), 'closed')
})

test('parseSubagentMode: 空/垃圾值一律 auto', () => {
  assert.equal(parseSubagentMode(null), 'auto')
  assert.equal(parseSubagentMode(undefined), 'auto')
  assert.equal(parseSubagentMode(''), 'auto')
  assert.equal(parseSubagentMode('???'), 'auto')
})

test('isExpanded: auto 有子智能体才展开', () => {
  assert.equal(isExpanded('auto', 0), false)
  assert.equal(isExpanded('auto', 1), true)
  assert.equal(isExpanded('auto', 5), true)
})

test('isExpanded: 手动 open/closed 覆盖 auto 判断', () => {
  assert.equal(isExpanded('open', 0), true)
  assert.equal(isExpanded('closed', 5), false)
})
