// 增量轮次重算的回归测试：node --experimental-strip-types --test scripts/turnsIncremental.test.mjs
//
// 关键约定：groupTurnsIncremental 的产出必须和全量 groupTurns 完全等价，
// 同时「没变的历史轮次」要保持对象引用不变（渲染层靠它跳过重渲染）。
import assert from 'node:assert/strict'
import test from 'node:test'

import { groupTurns, groupTurnsIncremental, sameTurn } from '../src/components/turns.ts'

/** 造 n 轮：assistant + user 交错，列表约定最新在前。 */
function build(n) {
  const messages = []
  let at = 1_700_000_000_000
  for (let i = 0; i < n; i += 1) {
    messages.push({
      id: `a${i}`,
      type: 'assistant',
      content: [
        { type: 'reasoning', text: `思考${i}` },
        { type: 'text', text: `正文${i}` },
        { type: 'tool', name: 'read', state: { status: 'completed', input: { filePath: 'a.ts' } } },
      ],
      time: { created: at, completed: at + 900 },
      tokens: { input: 10, output: 5 },
    })
    messages.push({ id: `u${i}`, type: 'user', text: `问题${i}`, time: { created: at } })
    at += 5000
  }
  // 列表约定「最新在前」：i 越大时间越晚，所以整体倒一次
  return messages.reverse()
}

const same = (a, b) => a.length === b.length && a.every((turn, i) => sameTurn(turn, b[i]))

test('首次计算与全量结果一致', () => {
  for (const n of [1, 2, 10, 200]) {
    const messages = build(n)
    const cache = groupTurnsIncremental(null, messages)
    assert.equal(same(cache.turns, groupTurns(messages)), true, `n=${n}`)
    assert.equal(cache.ids.length, cache.turns.length)
  }
})

test('流式改写最新一条：结果等价，历史轮次对象引用不变', () => {
  let messages = build(20)
  let cache = groupTurnsIncremental(null, messages)

  for (let k = 0; k < 40; k += 1) {
    messages = messages.map((message, index) =>
      index === 0 ? { ...message, content: [{ type: 'text', text: `增量${k}` }] } : message,
    )
    const next = groupTurnsIncremental(cache, messages)
    assert.equal(same(next.turns, groupTurns(messages)), true, `k=${k}`)
    // 最后一轮之外的全部轮次都应该是同一个对象
    for (let i = 0; i < next.turns.length - 1; i += 1) {
      assert.equal(next.turns[i], cache.turns[i], `第 ${i} 轮应复用`)
    }
    cache = next
  }
})

test('新轮次追加在前面：旧轮次复用，新轮次正确切分', () => {
  let messages = build(10)
  let cache = groupTurnsIncremental(null, messages)

  for (let k = 0; k < 5; k += 1) {
    messages = [
      {
        id: `na${k}`,
        type: 'assistant',
        content: [{ type: 'text', text: '新回复' }],
        time: { created: 2_000_000_000_000 + k, completed: 2_000_000_000_001 + k },
      },
      { id: `nu${k}`, type: 'user', text: '新问题', time: { created: 2_000_000_000_000 + k } },
      ...messages,
    ]
    const next = groupTurnsIncremental(cache, messages)
    assert.equal(same(next.turns, groupTurns(messages)), true, `k=${k}`)
    assert.equal(next.turns.length, cache.turns.length + 1)
    cache = next
  }
})

test('往上翻页插入更旧的消息：整体结果仍等价', () => {
  const messages = build(10)
  let cache = groupTurnsIncremental(null, messages)
  // 更旧的一页：id 不同，时间更早（列表尾部）
  const older = build(4).map((message, index) => ({ ...message, id: `old${index}` }))
  const merged = [...messages, ...older]
  cache = groupTurnsIncremental(cache, merged)
  assert.equal(same(cache.turns, groupTurns(merged)), true)
})

test('内容没变时直接复用整个结果', () => {
  const messages = build(8)
  const first = groupTurnsIncremental(null, messages)
  const again = groupTurnsIncremental(first, messages)
  for (let i = 0; i < first.turns.length; i += 1) {
    assert.equal(again.turns[i], first.turns[i])
  }
})

test('压缩摘要轮次的变化也要被识别', () => {
  const base = build(3)
  let cache = groupTurnsIncremental(null, base)
  // 压缩节点比所有消息都早 → 列表尾部 = 最早
  const withSummary = [
    ...base,
    {
      id: 'c1',
      type: 'compaction',
      summary: '压过的历史',
      time: { created: 1_600_000_000_000, completed: 1_600_000_000_100 },
    },
  ]
  cache = groupTurnsIncremental(cache, withSummary)
  assert.equal(same(cache.turns, groupTurns(withSummary)), true)
  // 倒序源数组里它排最后 → 时间正序后在第一位
  assert.equal(cache.turns[0].summary, '压过的历史')
})
