// 追加在 subagent.test.mjs 末尾的回归用例：pickActivity 必须返回「最新」的动作。
// 这个 bug 实测过：服务端消息倒序，旧实现从尾部扫 → 拿到子智能体最开始那个工具。
import assert from 'node:assert/strict'
import test from 'node:test'

import { pickActivity } from '../src/components/subagent.ts'

const toolPart = (name, created, input = {}) => ({
  type: 'tool',
  name,
  time: { created },
  state: { input },
})

test('pickActivity: 消息倒序（最新在前）时取最新那个工具', () => {
  // 服务端真实顺序：索引 0 = 最新
  const messages = [
    { type: 'assistant', time: { created: 3000 }, content: [toolPart('shell', 3100, { command: 'npm test' })] },
    { type: 'assistant', time: { created: 2000 }, content: [toolPart('write', 2100, { filePath: 'F:\\b.ts' })] },
    { type: 'assistant', time: { created: 1000 }, content: [toolPart('skill', 1100, { prompt: 'rust-wry' })] },
  ]
  const activity = pickActivity(messages)
  assert.equal(activity.tool, 'shell')
  assert.equal(activity.detail, 'npm test')
})

test('pickActivity: 消息正序（最旧在前）时同样取最新那个工具', () => {
  const messages = [
    { type: 'assistant', time: { created: 1000 }, content: [toolPart('skill', 1100)] },
    { type: 'assistant', time: { created: 2000 }, content: [toolPart('write', 2100)] },
    { type: 'assistant', time: { created: 3000 }, content: [toolPart('shell', 3100, { command: 'ls' })] },
  ]
  assert.equal(pickActivity(messages).tool, 'shell')
})

test('pickActivity: 同一条消息里取最后那个 part（part 时间递增）', () => {
  const messages = [
    {
      type: 'assistant',
      time: { created: 1000 },
      content: [toolPart('read', 1100), toolPart('bash', 1200, { command: 'git status' })],
    },
  ]
  const activity = pickActivity(messages)
  assert.equal(activity.tool, 'bash')
  assert.equal(activity.detail, 'git status')
})

test('pickActivity: 没有 part 时间时退回消息时间，仍取最新', () => {
  const messages = [
    { type: 'assistant', time: { created: 5000 }, content: [{ type: 'text', text: '新的' }] },
    { type: 'assistant', time: { created: 1000 }, content: [{ type: 'text', text: '旧的' }] },
  ]
  assert.equal(pickActivity(messages).detail, '新的')
})

test('pickActivity: 文本与工具混合时按时间取真正最新的那个', () => {
  const messages = [
    { type: 'assistant', time: { created: 3000 }, content: [{ type: 'text', text: '说完了' }] },
    { type: 'assistant', time: { created: 2000 }, content: [toolPart('read', 2500)] },
  ]
  const activity = pickActivity(messages)
  assert.equal(activity.tool, '')
  assert.equal(activity.detail, '说完了')
})

test('pickActivity: 同一条消息里「先调工具、后输出文字」应取文字（text 没有自己的时间）', () => {
  const messages = [
    {
      type: 'assistant',
      time: { created: 1000 },
      content: [toolPart('bash', 1200, { command: 'npm test' }), { type: 'text', text: '跑完了' }],
    },
  ]
  const activity = pickActivity(messages)
  assert.equal(activity.tool, '')
  assert.equal(activity.detail, '跑完了')
})
