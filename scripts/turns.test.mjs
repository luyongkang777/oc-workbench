// 消息分组 / 思考段的回归测试：node --experimental-strip-types --test scripts/turns.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatClock,
  formatSpan,
  groupTurns,
  reasoningLabel,
  sameTurn,
  turnTimeLabel,
} from '../src/components/turns.ts'

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

test('sameTurn：内容一样的两份轮次判为相同（引用不同）', () => {
  const build = () =>
    groupTurns([
      user('u1', '问题'),
      assistant(
        [
          { type: 'reasoning', text: '想一下', time: { created: 1, completed: 5 } },
          { type: 'text', text: '答案' },
          { type: 'tool', name: 'read', state: { status: 'completed', input: { path: 'a.js' } } },
        ],
        { created: 1, completed: 9 },
      ),
    ])
  const a = build()
  const b = build()
  assert.notEqual(a[0], b[0])
  assert.equal(sameTurn(a[0], b[0]), true)
})

test('sameTurn：文字变了要判为不同（否则界面不更新）', () => {
  const base = (text) =>
    groupTurns([assistant([{ type: 'text', text }], { created: 1, completed: 2 })])[0]

  assert.equal(sameTurn(base('旧文本'), base('新文本')), false)
})

test('sameTurn：思考段进行中的状态变化要判为不同（标题要走秒）', () => {
  const running = groupTurns([
    assistant([{ type: 'reasoning', text: '', time: { created: 5 } }], { created: 5 }),
  ])[0]
  const done = groupTurns([
    assistant([{ type: 'reasoning', text: '', time: { created: 5, completed: 8 } }], {
      created: 5,
      completed: 9,
    }),
  ])[0]

  assert.equal(sameTurn(running, done), false)
})

test('sameTurn：工具状态变化要判为不同', () => {
  const build = (status) =>
    groupTurns([
      assistant([{ type: 'tool', name: 'read', state: { status } }], { created: 1, completed: 2 }),
    ])[0]

  assert.equal(sameTurn(build('running'), build('completed')), false)
})

test('sameTurn：块数量变化要判为不同', () => {
  const one = groupTurns([
    assistant([{ type: 'text', text: 'a' }], { created: 1, completed: 2 }),
  ])[0]
  const two = groupTurns([
    assistant([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], {
      created: 1,
      completed: 2,
    }),
  ])[0]

  assert.equal(sameTurn(one, two), false)
})

test('压缩消息的 summary 要成为一轮，正文来自 summary 而不是 content', () => {
  const turns = groupTurns([
    { id: 'msg_c', type: 'compaction', summary: '## Objective\n- 之前的任务', content: [], time: { completed: 100 } },
    user('u1', '压缩摘要'),
  ])
  assert.equal(turns.length, 2)
  assert.equal(turns[0].user, '压缩摘要')
  assert.equal(turns[1].summary, '## Objective\n- 之前的任务')
  assert.equal(turns[1].summaryAt, 100)
  assert.equal(turns[1].user, undefined)
  assert.equal(turns[1].blocks.length, 0)
})

test('没有正文的压缩消息（content 空、summary 也空）直接跳过，不造空轮次', () => {
  const turns = groupTurns([
    { id: 'msg_c', type: 'compaction', content: [] },
    user('u1', '你好'),
  ])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].user, '你好')
})

test('压缩节点之后的连续回复只共用一个续接轮，不是一条消息一轮', () => {
  // 服务端倒序：最新在前。时间正序是 u1 → 压缩 → a1 → a2 → a3
  const step = (id) => ({
    id,
    type: 'assistant',
    content: [{ type: 'text', text: `${id} 的正文` }],
    time: { created: Number(id.slice(1)) * 10, completed: Number(id.slice(1)) * 10 + 5 },
  })
  const turns = groupTurns([
    step('a3'),
    step('a2'),
    step('a1'),
    { id: 'msg_c', type: 'compaction', summary: '之前的任务', content: [] },
    user('u1', '第一个问题'),
  ])

  // 提问一轮 + 压缩摘要一轮 + 压缩后的续接一轮
  assert.equal(turns.length, 3)
  assert.equal(turns[0].user, '第一个问题')
  assert.equal(turns[1].summary, '之前的任务')
  assert.equal(turns[2].user, undefined)
  // 三段连续正文会并成一块渲染，但三条消息确实都归属这一轮（顺序按时间正序）
  assert.deepEqual(turns[2].texts, ['a1 的正文', 'a2 的正文', 'a3 的正文'])
})

test('sameTurn：摘要内容变化必须重渲染', () => {
  const build = (summary) =>
    groupTurns([{ id: 'msg_c', type: 'compaction', summary, time: { completed: 1 } }])[0]
  assert.equal(sameTurn(build('a'), build('a')), true)
  assert.equal(sameTurn(build('a'), build('b')), false)
})

test('压缩失败的消息（服务端 200 + error）也要占一轮，带上原因', () => {
  const turns = groupTurns([
    {
      id: 'msg_c',
      type: 'compaction',
      content: [],
      error: { type: 'compaction.unavailable', message: 'Nothing to compact yet' },
      time: { created: 5 },
    },
  ])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].summary, undefined)
  assert.equal(turns[0].summaryError, 'Nothing to compact yet')
  assert.equal(turns[0].summaryAt, 5)
})

test('轮次时间：起点取用户提问，终点取最后一条回复的完成时间', () => {
  const turns = groupTurns([
    { id: 'a2', type: 'assistant', content: [{ type: 'text', text: '补充' }], time: { created: 5000, completed: 8000 } },
    { id: 'a1', type: 'assistant', content: [{ type: 'text', text: '答案' }], time: { created: 1200, completed: 4000 } },
    { id: 'u1', type: 'user', text: '问题', time: { created: 1000 } },
  ])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].startedAt, 1000)
  assert.equal(turns[0].endedAt, 8000)
})

test('轮次时间：还在生成时没有结束时间，起点退回首条回复的 created', () => {
  const turns = groupTurns([
    { id: 'a1', type: 'assistant', content: [{ type: 'reasoning', text: '', time: { created: 4 } }], time: { created: 3000 } },
  ])
  assert.equal(turns[0].startedAt, 3000)
  assert.equal(turns[0].endedAt, undefined)
})

test('轮次时间：user 消息没有 time 时仍能从回复拿到起点', () => {
  const turns = groupTurns([
    { id: 'a1', type: 'assistant', content: [{ type: 'text', text: '嗯' }], time: { created: 700, completed: 900 } },
    { id: 'u1', type: 'user', text: '在吗' },
  ])
  assert.equal(turns[0].startedAt, 700)
  assert.equal(turns[0].endedAt, 900)
})

test('时间文案：当天只给时分，跨天带日期，跨年带年份', () => {
  const now = new Date(2026, 10, 12, 20, 0, 0).getTime()
  assert.equal(formatClock(new Date(2026, 10, 12, 19, 42, 30).getTime(), now), '19:42')
  assert.equal(formatClock(new Date(2026, 10, 10, 9, 5, 0).getTime(), now), '11-10 09:05')
  assert.equal(formatClock(new Date(2025, 11, 31, 23, 59, 0).getTime(), now), '2025-12-31 23:59')
})

test('耗时文案：秒 / 分秒 / 整分 / 小时分', () => {
  assert.equal(formatSpan(12_000), '12 秒')
  assert.equal(formatSpan(0), '0 秒')
  assert.equal(formatSpan(332_000), '5 分 32 秒')
  assert.equal(formatSpan(600_000), '10 分')
  assert.equal(formatSpan(3_780_000), '1 小时 3 分')
})

test('turnTimeLabel：没有时间不给文案，只有起点时不显示结束与用时', () => {
  const now = new Date(2026, 10, 12, 20, 0, 0).getTime()
  assert.equal(turnTimeLabel({}, now), null)
  assert.deepEqual(turnTimeLabel({ startedAt: new Date(2026, 10, 12, 19, 42, 0).getTime() }, now), {
    start: '19:42',
    end: '',
    span: '',
  })
  assert.deepEqual(
    turnTimeLabel(
      {
        startedAt: new Date(2026, 10, 12, 19, 42, 0).getTime(),
        endedAt: new Date(2026, 10, 12, 19, 48, 12).getTime(),
      },
      now,
    ),
    { start: '19:42', end: '19:48', span: '6 分 12 秒' },
  )
})

test('sameTurn：结束时间补上必须重渲染，否则界面上永远看不到结束时间', () => {
  const running = groupTurns([assistant([{ type: 'text', text: 'a' }], { created: 10 })])[0]
  const done = groupTurns([assistant([{ type: 'text', text: 'a' }], { created: 10, completed: 50 })])[0]
  assert.equal(sameTurn(running, done), false)
})
