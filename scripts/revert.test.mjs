// 回撤（revert）纯逻辑的回归测试：node --experimental-strip-types --test scripts/revert.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasBoundary,
  joinRevertedDraft,
  lastUserBoundary,
  revertNoticeText,
  sliceAtRevert,
} from '../src/components/revert.ts'
import { messageFilesToAttachments } from '../src/components/attachments.ts'

/** 服务端顺序：最新在前。 */
function msg(id, type) {
  return { id, type, text: id }
}

const messages = [msg('m5', 'assistant'), msg('m4', 'user'), msg('m3', 'assistant'), msg('m2', 'user'), msg('m1', 'assistant')]

test('回撤边界之后的消息被隐藏（边界自己也藏）', () => {
  assert.deepEqual(
    sliceAtRevert(messages, 'm4').map((m) => m.id),
    ['m3', 'm2', 'm1'],
  )
  assert.deepEqual(
    sliceAtRevert(messages, 'm2').map((m) => m.id),
    ['m1'],
  )
})

test('没有边界 / 边界已经不在本地时原样返回', () => {
  assert.equal(sliceAtRevert(messages, null).length, 5)
  assert.equal(sliceAtRevert(messages, undefined).length, 5)
  // 已经被 commit 删掉的消息：库里没有它，不能把整段历史藏起来
  assert.equal(sliceAtRevert(messages, 'gone').length, 5)
})

test('hasBoundary 只认真正在列表里的 id', () => {
  assert.equal(hasBoundary(messages, 'm4'), true)
  assert.equal(hasBoundary(messages, 'gone'), false)
  assert.equal(hasBoundary(messages, null), false)
})

test('回撤原文放回输入框时不吞掉原有草稿', () => {
  assert.equal(joinRevertedDraft('hello', ''), 'hello')
  assert.equal(joinRevertedDraft('hello', '   '), 'hello')
  assert.equal(joinRevertedDraft('hello', 'draft'), 'hello\n\ndraft')
  // 回撤消息本身是空文本（纯附件消息）时保留原草稿
  assert.equal(joinRevertedDraft('', 'draft'), 'draft')
})

test('提示文案说明「还没有真删」', () => {
  assert.match(revertNoticeText(), /已回撤/)
})

test('消息附件能转回可再次发送的附件', () => {
  const b64 = Buffer.from('hello').toString('base64')
  const restored = messageFilesToAttachments([
    { name: 'note.txt', mime: 'text/plain', data: b64 },
    { name: 'broken', mime: 'text/plain' },
  ])
  assert.equal(restored.length, 1)
  assert.equal(restored[0].name, 'note.txt')
  assert.equal(restored[0].bytes, 5)
  assert.equal(restored[0].dataUrl, `data:text/plain;base64,${b64}`)
})

test('「回到上一版」定位最近一条用户消息，而不是末尾的助手回复', () => {
  // 末尾是助手回复时也要落在 m4：留一条 assistant 在边界外，界面上才看不出「命令还在、结果没了」
  assert.equal(lastUserBoundary(messages)?.id, 'm4')
})

test('只有一条提问时也定位到它', () => {
  assert.equal(lastUserBoundary([msg('a1', 'assistant'), msg('u1', 'user')])?.id, 'u1')
})

test('没有提问（空会话 / 只有助手消息）时返回 null', () => {
  assert.equal(lastUserBoundary([]), null)
  assert.equal(lastUserBoundary([msg('a1', 'assistant'), msg('a2', 'assistant')]), null)
})
