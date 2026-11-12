// 消息合并（历史不丢）的回归测试：node --experimental-strip-types --test scripts/messages.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeMessages, sessionLastAt } from '../src/api/chat.ts'

const msg = (id, created) => ({ id, type: 'assistant', time: { created } })

test('新一页只覆盖同 id 的消息，本地更早的历史必须留住', () => {
  const prev = [msg('m5', 50), msg('m4', 40), msg('m3', 30), msg('m2', 20), msg('m1', 10)]
  const fresh = [msg('m5', 50), msg('m4b', 41)]
  const merged = mergeMessages(prev, fresh)
  assert.deepEqual(
    merged.map((m) => m.id),
    ['m5', 'm4b', 'm4', 'm3', 'm2', 'm1'],
  )
})

test('同 id 以服务端最新内容为准', () => {
  const prev = [{ id: 'm1', type: 'assistant', time: { created: 1 }, text: '旧' }]
  const fresh = [{ id: 'm1', type: 'assistant', time: { created: 1 }, text: '新' }]
  assert.equal(mergeMessages(prev, fresh)[0].text, '新')
})

test('没有 created 的流式骨架排在最前，不会被挤到历史底部', () => {
  const prev = [msg('m2', 20), msg('m1', 10)]
  const fresh = [{ id: 'skeleton', type: 'assistant' }]
  assert.deepEqual(
    mergeMessages(prev, fresh).map((m) => m.id),
    ['skeleton', 'm2', 'm1'],
  )
})

test('重复合并幂等：刷新多次不会长出重复消息', () => {
  const prev = [msg('m2', 20), msg('m1', 10)]
  const fresh = [msg('m2', 20)]
  const once = mergeMessages(prev, fresh)
  const twice = mergeMessages(once, fresh)
  assert.deepEqual(
    twice.map((m) => m.id),
    ['m2', 'm1'],
  )
})

test('空页不改变已有历史', () => {
  const prev = [msg('m1', 1)]
  assert.deepEqual(
    mergeMessages(prev, []).map((m) => m.id),
    ['m1'],
  )
})

test('会话条目时间：优先 time.updated，缺省退到 created，0 视为没有', () => {
  assert.equal(sessionLastAt({ id: 's1', time: { created: 1, updated: 9 } }), 9)
  assert.equal(sessionLastAt({ id: 's2', time: { created: 5 } }), 5)
  assert.equal(sessionLastAt({ id: 's3', time: { created: 0, updated: 0 } }), undefined)
  assert.equal(sessionLastAt({ id: 's4' }), undefined)
})

test('会话条目时间：生成中的 busy/idle 不能当成最后一次对话时间', () => {
  assert.equal(sessionLastAt({ id: 's5', time: { busy: 999, idle: 1 } }), undefined)
})
