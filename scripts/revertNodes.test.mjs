// 「修改记录」节点的纯逻辑测试：
// node --experimental-strip-types --test scripts/revertNodes.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_NODES,
  buildRevertNodes,
  filesSummary,
  nodeSummary,
} from '../src/components/revertNodes.ts'

/** 服务端顺序：最新在前。 */
function user(id, text, extra = {}) {
  return { id, type: 'user', text, ...extra }
}
function assistant(id) {
  return { id, type: 'assistant', content: [] }
}

test('只认用户消息：助手回复和 idle 标记都不是节点', () => {
  const nodes = buildRevertNodes([
    assistant('a3'),
    user('u2', '第二次'),
    assistant('a2'),
    user('u1', '第一次'),
  ])
  assert.deepEqual(nodes.map((n) => n.messageID), ['u2', 'u1'])
})

test('返回顺序最新在前，序号按时间正序编号', () => {
  const nodes = buildRevertNodes([user('u3', 'c'), user('u2', 'b'), user('u1', 'a')])
  assert.deepEqual(nodes.map((n) => n.messageID), ['u3', 'u2', 'u1'])
  // 最新的是第 3 轮，最早的是第 1 轮
  assert.deepEqual(nodes.map((n) => n.index), [3, 2, 1])
  assert.deepEqual(nodes.map((n) => n.age), [0, 1, 2])
})

test('最多保留 10 个节点，且留下的是最近的', () => {
  const many = []
  for (let i = 15; i >= 1; i -= 1) many.push(user(`u${i}`, `第 ${i} 轮`))
  const nodes = buildRevertNodes(many)
  assert.equal(nodes.length, MAX_NODES)
  assert.equal(nodes[0].messageID, 'u15')
  assert.equal(nodes[9].messageID, 'u6')
  // 序号仍然是真实轮次，不是 1..10
  assert.equal(nodes[0].index, 15)
  assert.equal(nodes[9].index, 6)
})

test('limit 可控；limit<=0 返回空', () => {
  const nodes = [user('u3', 'c'), user('u2', 'b'), user('u1', 'a')]
  assert.equal(buildRevertNodes(nodes, 2).length, 2)
  assert.equal(buildRevertNodes(nodes, 0).length, 0)
  assert.equal(buildRevertNodes(nodes, -1).length, 0)
})

test('空会话返回空数组', () => {
  assert.deepEqual(buildRevertNodes([]), [])
  assert.deepEqual(buildRevertNodes([assistant('a1')]), [])
})

test('附件和时间戳一起带出来（回撤要放回输入框）', () => {
  const files = [{ name: 'a.png', mime: 'image/png', data: 'AAA' }]
  const nodes = buildRevertNodes([user('u1', '', { files, time: { created: 1795000000000 } })])
  assert.equal(nodes[0].files.length, 1)
  assert.equal(nodes[0].at, 1795000000000)
})

test('摘要压成一行；没文字就说附件数 / 空消息', () => {
  assert.equal(nodeSummary({ text: '把  a.js\n改成 b.js', files: [] }), '把 a.js 改成 b.js')
  assert.equal(nodeSummary({ text: '', files: [{ name: 'x' }] }), '（1 个附件）')
  assert.equal(nodeSummary({ text: '   ', files: [] }), '（空消息）')
})

test('文件改动合计：没改动要说清楚，不是 0 个文件', () => {
  assert.equal(filesSummary([]), '没有文件改动')
  assert.equal(
    filesSummary([
      { additions: 10, deletions: 2 },
      { additions: 5, deletions: 1 },
    ]),
    '2 个文件 +15 -3',
  )
})
