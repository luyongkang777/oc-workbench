// 流式增量补丁的回归测试：node --experimental-strip-types --test scripts/streamPatch.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { appendText, ensureMessage, finishMessage, setText } from '../src/components/streamPatch.ts'

const msg = (id, text) => ({ id, type: 'assistant', content: [{ type: 'text', text }] })
const textOf = (messages, id) => {
  const m = messages.find((x) => x.id === id)
  return (m?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '')
}

test('ensureMessage：不存在时插到最前面（列表最新在前）', () => {
  const next = ensureMessage([msg('old', '旧')], 'new', { time: { created: 5 } })
  assert.equal(next[0].id, 'new')
  assert.equal(next.length, 2)
  assert.equal(next[0].time.created, 5)
})

test('ensureMessage：已存在时原样返回同一个数组', () => {
  const list = [msg('a', 'x')]
  assert.equal(ensureMessage(list, 'a'), list)
})

test('appendText：往指定消息追加，不动别的', () => {
  const list = [msg('a', '你好'), msg('b', '别的')]
  const next = appendText(list, 'a', 0, '，世界')
  assert.deepEqual(textOf(next, 'a'), ['你好，世界'])
  assert.deepEqual(textOf(next, 'b'), ['别的'])
  assert.deepEqual(textOf(list, 'a'), ['你好'], '原数组不能被改')
})

test('appendText：消息不存在时原样返回（等 step.started 建骨架）', () => {
  const list = [msg('a', 'x')]
  assert.equal(appendText(list, 'ghost', 0, 'y'), list)
})

test('appendText：ordinal 大于 0 时补齐中间的空段', () => {
  const list = [msg('a', '第一段')]
  const next = appendText(list, 'a', 2, '第三段')
  assert.deepEqual(textOf(next, 'a'), ['第一段', '', '第三段'])
})

test('appendText：空 delta 不产生新数组', () => {
  const list = [msg('a', 'x')]
  assert.equal(appendText(list, 'a', 0, ''), list)
})

test('setText：用全文覆盖（定稿校对，防增量丢字）', () => {
  const list = [msg('a', '半截')]
  const next = setText(list, 'a', 0, '完整的一句话')
  assert.deepEqual(textOf(next, 'a'), ['完整的一句话'])
})

test('setText：内容一致时返回原数组，省掉一次重渲染', () => {
  const list = [msg('a', '一样')]
  assert.equal(setText(list, 'a', 0, '一样'), list)
})

test('finishMessage：打上完成时间，思考指示能收起来', () => {
  const list = [{ id: 'a', type: 'assistant', content: [], time: { created: 1 } }]
  const next = finishMessage(list, 'a', 9)
  assert.equal(next[0].time.completed, 9)
  assert.equal(next[0].time.created, 1)
  assert.equal(list[0].time.completed, undefined, '原对象不能改')
})
