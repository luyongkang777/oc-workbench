// 自动重投判定的回归：node --experimental-strip-types --test scripts/chatAutoRetry.test.mjs
//
// 这个判定错了会很糟：
//   - 把「已成功的轮次」当成失败 → 无限重投，模型被反复调用（烧钱）；
//   - 把「正在跑的轮次」当成失败 → 一条消息重投两遍；
//   - 认不出失败 → 用户看到的还是「发出去永远没回复」。
import assert from 'node:assert/strict'
import test from 'node:test'

import { pendingRetry } from '../src/components/chatAutoRetry.ts'

/** 服务端消息接口是倒序（最新在前），这里按同样约定造数据。 */
function desc(list) {
  return [...list].reverse()
}

const user = (id, text) => ({ id, type: 'user', text, time: { created: 1 } })
const idle = (id, outcome, error) => ({ id, type: 'idle', outcome, ...(error ? { error } : {}) })
const assistantText = (id, text) => ({
  id,
  type: 'assistant',
  content: [{ type: 'text', text }],
  time: { created: 2 },
})
const assistantDone = (id) => ({
  id,
  type: 'assistant',
  content: [],
  time: { created: 2, completed: 3 },
})

test('空列表 / 没有用户消息：不重投', () => {
  assert.equal(pendingRetry([]), null)
  assert.equal(pendingRetry(desc([idle('i1', 'failed', { message: 'x' })])), null)
})

test('用户消息后紧跟失败 idle：认出要重投', () => {
  const messages = desc([user('msg_u1', '你好'), idle('msg_i1', 'failed', { type: 'provider.rate_limit', message: '429 限流', status: 429 })])
  const retry = pendingRetry(messages)
  assert.ok(retry, '应当认出失败')
  assert.equal(retry.userMessageID, 'msg_u1')
  assert.equal(retry.text, '你好')
  assert.equal(retry.attempts, 1)
  assert.equal(retry.failure.status, 429)
})

test('有 assistant 输出：不算失败（已经跑起来了）', () => {
  const withText = desc([user('msg_u1', '你好'), idle('msg_i1', 'failed', {}), assistantText('msg_a1', '回复中')])
  assert.equal(pendingRetry(withText), null)

  const completed = desc([user('msg_u1', '你好'), idle('msg_i1', 'failed', {}), assistantDone('msg_a1')])
  assert.equal(pendingRetry(completed), null, '写了 completed 也算有输出')
})

test('最新结局是成功或中断：不重投', () => {
  assert.equal(pendingRetry(desc([user('msg_u1', 'x'), idle('msg_i1', 'succeeded')])), null)
  assert.equal(pendingRetry(desc([user('msg_u1', 'x'), idle('msg_i1', 'interrupted')])), null)
})

test('多次失败累加次数，供上限判定用', () => {
  const messages = desc([
    user('msg_u1', '再试一次'),
    idle('msg_i1', 'failed', { message: 'fetch failed' }),
    idle('msg_i2', 'failed', { message: 'fetch failed' }),
    idle('msg_i3', 'failed', { message: 'ECONNRESET' }),
  ])
  const retry = pendingRetry(messages)
  assert.ok(retry)
  assert.equal(retry.attempts, 3)
  assert.match(retry.failure.message, /ECONNRESET/)
})

test('只看最新一轮：上一轮的失败不该被翻出来重投', () => {
  const messages = desc([
    user('msg_u1', '第一条'),
    idle('msg_i1', 'failed', { message: 'fetch failed' }),
    user('msg_u2', '第二条'),
    assistantText('msg_a2', '第二条的回复'),
  ])
  assert.equal(pendingRetry(messages), null, '最新一轮已经成功')

  const stillFailing = desc([
    user('msg_u1', '第一条'),
    idle('msg_i1', 'failed', { message: 'fetch failed' }),
    user('msg_u2', '第二条'),
    idle('msg_i2', 'failed', { message: 'fetch failed' }),
  ])
  const retry = pendingRetry(stillFailing)
  assert.ok(retry)
  assert.equal(retry.userMessageID, 'msg_u2', '重投要针对最新那条用户消息')
})

test('失败次数只算当前这轮：前面几轮的失败不累加', () => {
  const messages = desc([
    user('msg_u1', '第一条'),
    idle('msg_i1', 'failed', {}),
    idle('msg_i2', 'failed', {}),
    user('msg_u2', '第二条'),
    idle('msg_i3', 'failed', {}),
  ])
  const retry = pendingRetry(messages)
  assert.ok(retry)
  assert.equal(retry.attempts, 1, '第二条只失败了一次')
})

test('空消息（无正文无附件）不重投，避免 400', () => {
  const messages = desc([user('msg_u1', '   '), idle('msg_i1', 'failed', {})])
  assert.equal(pendingRetry(messages), null)
})

test('带附件的空正文消息仍然要重投（图片消息没有文字）', () => {
  const withFile = desc([
    { id: 'msg_u1', type: 'user', text: '', files: [{ name: 'a.png', data: 'AAA', mime: 'image/png' }] },
    idle('msg_i1', 'failed', { message: 'fetch failed' }),
  ])
  const retry = pendingRetry(withFile)
  assert.ok(retry)
  assert.equal(retry.files.length, 1)
})

test('失败的 assistant 空消息带 completed 时间戳，仍要识别成待重投（429 实测结构）', () => {
  const messages = desc([
    user('msg_u1', '你好'),
    {
      id: 'msg_a1',
      type: 'assistant',
      content: [],
      error: { type: 'provider.rate-limit', message: '429 限流', status: 429 },
      time: { created: 2, completed: 3 },
    },
    idle('msg_i1', 'failed', { type: 'provider.rate-limit', message: '429 限流', status: 429 }),
  ])
  const retry = pendingRetry(messages)
  assert.ok(retry, '失败 assistant 有 completed 也不能挡住重投')
  assert.equal(retry.attempts, 1)
  assert.equal(retry.failure.status, 429)
})

test('已经写出一部分内容的 assistant 报错：算有输出，不重投（避免重复内容）', () => {
  const messages = desc([
    user('msg_u1', '你好'),
    {
      id: 'msg_a1',
      type: 'assistant',
      content: [{ type: 'text', text: '已经写了一半' }],
      error: { type: 'provider.rate-limit', message: '429', status: 429 },
      time: { created: 2, completed: 3 },
    },
    idle('msg_i1', 'failed', { message: '429', status: 429 }),
  ])
  assert.equal(pendingRetry(messages), null)
})

test('成功但内容为空的 assistant（无 error）仍算有输出', () => {
  const messages = desc([
    user('msg_u1', '你好'),
    { id: 'msg_a1', type: 'assistant', content: [], time: { created: 2, completed: 3 } },
    idle('msg_i1', 'failed', { message: '429' }),
  ])
  assert.equal(pendingRetry(messages), null)
})
