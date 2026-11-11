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

test('思考/说话/工具按原始顺序交错成 blocks，而不是各并一块', () => {
  const turns = groupTurns([
    assistant(
      [
        { type: 'reasoning', text: '先看文件', time: { created: 10, completed: 20 } },
        { type: 'text', text: '我看一下 a.js' },
        { type: 'tool', name: 'read', state: { status: 'completed', input: { path: 'a.js' } } },
        { type: 'reasoning', text: '再看 b.js', time: { created: 30, completed: 40 } },
        { type: 'text', text: '结论：没问题' },
      ],
      { created: 1, completed: 50 },
    ),
  ])

  const blocks = turns[0].blocks
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['reasoning', 'text', 'tools', 'reasoning', 'text'],
  )
  assert.equal(blocks[0].text, '先看文件')
  assert.equal(blocks[3].text, '再看 b.js')
  assert.equal(blocks[4].text, '结论：没问题')
})

test('连续的 text 段合成一块，中间隔了工具就断开', () => {
  const turns = groupTurns([
    assistant(
      [
        { type: 'text', text: '第一句' },
        { type: 'text', text: '第二句' },
        { type: 'tool', name: 'read', state: { status: 'completed' } },
        { type: 'text', text: '第三句' },
      ],
      { created: 1, completed: 9 },
    ),
  ])

  const blocks = turns[0].blocks
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['text', 'tools', 'text'],
  )
  assert.equal(blocks[0].text, '第一句\n\n第二句')
  assert.equal(blocks[2].text, '第三句')
})

test('连着调的工具进同一组，中间有文字就另起一组', () => {
  const turns = groupTurns([
    assistant(
      [
        { type: 'tool', name: 'read', state: { status: 'completed' } },
        { type: 'tool', name: 'grep', state: { status: 'completed' } },
        { type: 'text', text: '找到了' },
        { type: 'tool', name: 'edit', state: { status: 'completed' } },
      ],
      { created: 1, completed: 9 },
    ),
  ])

  const blocks = turns[0].blocks
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['tools', 'text', 'tools'],
  )
  assert.equal(blocks[0].tools.length, 2)
  assert.equal(blocks[2].tools.length, 1)
})

test('进行中的思考段单独成块并标记 active，空文本也占位', () => {
  const turns = groupTurns([
    assistant([{ type: 'reasoning', text: '', time: { created: 5 } }], { created: 5 }),
  ])

  const block = turns[0].blocks[0]
  assert.equal(block.kind, 'reasoning')
  assert.equal(block.active, true)
  assert.equal(block.startedAt, 5)
  assert.equal(block.text, '')
})

test('已结束且没有文本的思考段不生成空块', () => {
  const turns = groupTurns([
    assistant([{ type: 'reasoning', text: '', time: { created: 1, completed: 2 } }], {
      created: 1,
      completed: 3,
    }),
  ])

  assert.equal(turns[0].blocks.length, 0)
  // 耗时照样记着，别因为没文本就丢
  assert.equal(turns[0].reasoningMs, 1)
})

test('blocks 的 key 在消息之间也不撞', () => {
  const turns = groupTurns([
    { id: 'm2', type: 'assistant', content: [{ type: 'text', text: 'b' }], time: { created: 6, completed: 7 } },
    user('u1', '问题'),
    { id: 'm1', type: 'assistant', content: [{ type: 'text', text: 'a' }], time: { created: 2, completed: 3 } },
  ])

  const keys = turns.flatMap((t) => t.blocks.map((b) => b.key))
  assert.equal(new Set(keys).size, keys.length)
})
