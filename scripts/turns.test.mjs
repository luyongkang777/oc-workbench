// 消息分组 / 思考段的回归测试：node --experimental-strip-types --test scripts/turns.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { groupTurns, reasoningLabel } from '../src/components/turns.ts'

const assistant = (content, time) => ({ id: 'msg_a', type: 'assistant', content, time })
const user = (id, text) => ({ id, type: 'user', text })

test('消息倒序进来时按提问切轮次并正序排列', () => {
  const turns = groupTurns([
    assistant([{ type: 'text', text: '第二个回复' }], { created: 2, completed: 3 }),
    user('u2', '第二个问题'),
    assistant([{ type: 'text', text: '第一个回复' }], { created: 1, completed: 2 }),
    user('u1', '第一个问题'),
  ])
  assert.equal(turns.length, 2)
  assert.equal(turns[0].user, '第一个问题')
  assert.deepEqual(turns[0].texts, ['第一个回复'])
  assert.equal(turns[1].user, '第二个问题')
  assert.deepEqual(turns[1].texts, ['第二个回复'])
})

test('reasoning 段聚合成思考全文，未完成时标记 active', () => {
  const turns = groupTurns([
    user('u1', '问题'),
    assistant(
      [
        { type: 'reasoning', text: '先想第一步', time: { created: 1000 } },
        { type: 'reasoning', text: '再想第二步', time: { created: 1100 } },
      ],
      { created: 900 },
    ),
  ])
  assert.equal(turns[0].reasoning, '先想第一步\n\n再想第二步')
  assert.equal(turns[0].reasoningActive, true)
  assert.equal(turns[0].reasoningStartedAt, 1000)
})

test('消息已完成时不再算思考中，并累计思考耗时', () => {
  const turns = groupTurns([
    user('u1', '问题'),
    assistant(
      [
        { type: 'reasoning', text: '第一段', time: { created: 1000, completed: 2400 } },
        { type: 'reasoning', text: '第二段', time: { created: 2500, completed: 3000 } },
        { type: 'text', text: '答案' },
      ],
      { created: 900, completed: 3100 },
    ),
  ])
  assert.equal(turns[0].reasoningActive, false)
  assert.equal(turns[0].reasoningMs, 1400 + 500)
  assert.deepEqual(turns[0].texts, ['答案'])
})

test('空 reasoning 段只保留 active，不产生空行', () => {
  const turns = groupTurns([
    user('u1', '问题'),
    assistant([{ type: 'reasoning', text: '', time: { created: 5000 } }], { created: 4000 }),
  ])
  assert.equal(turns[0].reasoning, '')
  assert.equal(turns[0].reasoningActive, true)
})

test('工具段提取名称、状态与详情', () => {
  const turns = groupTurns([
    user('u1', '问题'),
    assistant([
      {
        type: 'tool',
        name: 'bash',
        state: { status: 'completed', input: { command: 'npm run build' } },
      },
    ]),
  ])
  assert.deepEqual(turns[0].tools, [{ name: 'bash', status: 'completed', detail: 'npm run build' }])
})

test('思考时长文案：进行中走秒，结束显示累计秒数', () => {
  assert.equal(reasoningLabel({ reasoningActive: true, reasoningMs: 0, reasoningStartedAt: 1000 }, 4500), '思考中… 4s')
  assert.equal(reasoningLabel({ reasoningActive: false, reasoningMs: 3400, reasoningStartedAt: null }), '思考过程 3s')
  assert.equal(reasoningLabel({ reasoningActive: false, reasoningMs: 200, reasoningStartedAt: null }), '思考过程')
})

test('用户消息的图片附件挂到对应轮次上', () => {
  const turns = groupTurns([
    { id: 'm1', type: 'user', text: '看图', files: [{ name: 'a.png', mime: 'image/png', data: 'AAAA' }] },
  ])
  assert.equal(turns[0].files.length, 1)
  assert.equal(turns[0].files[0].name, 'a.png')
})

test('没有用户消息的轮次 files 是空数组（模板不用判空）', () => {
  const turns = groupTurns([assistant([{ type: 'text', text: '只有回复' }], { created: 1 })])
  assert.deepEqual(turns[0].files, [])
})
