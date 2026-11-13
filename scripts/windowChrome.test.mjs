// 自绘标题栏 + 会话模式记忆的纯函数回归。
// node --experimental-strip-types --test scripts/windowChrome.test.mjs
//
// 两类错最容易出：
//   1. 顶栏按下时把按钮/标签也当成拖动区 → 点「Git」「审查」变成拖窗口；
//   2. 切会话/切标签重挂载后把模式写成空串 → 界面显示 build，服务端还在 ask。
import assert from 'node:assert/strict'
import test from 'node:test'

import { isWindowDragTarget } from '../src/api/window.ts'
import {
  parseAgentMemory,
  resolveSessionAgent,
  trimAgentMemory,
} from '../src/components/agentMemory.ts'

/** 假元素：只实现 closest，够 isWindowDragTarget 用。 */
const el = (match) => ({ closest: (selector) => (match ? { selector } : null) })
const plain = () => ({ closest: () => null })

test('顶栏空白处可以拖窗口', () => {
  assert.equal(isWindowDragTarget(plain()), true)
})

test('按钮/标签/输入框上不拖窗口', () => {
  assert.equal(isWindowDragTarget(el(true)), false)
})

test('没有 closest 的目标不拖（null、文本节点、window 之类）', () => {
  assert.equal(isWindowDragTarget(null), false)
  assert.equal(isWindowDragTarget(undefined), false)
  assert.equal(isWindowDragTarget({}), false)
  assert.equal(isWindowDragTarget('text'), false)
})

test('选择器覆盖窗口按钮自身，避免点关闭时先拖一下', () => {
  const seen = []
  isWindowDragTarget({ closest: (selector) => (seen.push(selector), null) })
  const selector = seen[0]
  for (const part of ['button', 'input', '[role="tab"]', '[data-win-controls]']) {
    assert.ok(selector.includes(part), `选择器缺少 ${part}：${selector}`)
  }
})

test('存储坏值不会把脏数据带进界面', () => {
  assert.deepEqual(parseAgentMemory(null), {})
  assert.deepEqual(parseAgentMemory(''), {})
  assert.deepEqual(parseAgentMemory('not json'), {})
  assert.deepEqual(parseAgentMemory('[]'), {})
  assert.deepEqual(parseAgentMemory('null'), {})
  assert.deepEqual(parseAgentMemory('{"ses_1":"ask","ses_2":"","ses_3":5}'), {
    ses_1: 'ask',
  })
})

test('服务端记的 agent 优先，没有才用本地记忆', () => {
  assert.equal(resolveSessionAgent('plan', 'ask'), 'plan')
  assert.equal(resolveSessionAgent(undefined, 'ask'), 'ask')
  assert.equal(resolveSessionAgent('', 'ask'), 'ask')
  // 两边都没有：空串 = 跟随服务端默认，界面显示第一个 agent
  assert.equal(resolveSessionAgent(undefined, undefined), '')
})

test('模式记忆超过上限时先淘汰最旧的', () => {
  const map = { ses_0: 'ask', ses_1: 'plan', ses_2: 'build', ses_3: 'debug', ses_4: 'ask' }
  assert.deepEqual(Object.keys(trimAgentMemory(map, 3)), ['ses_2', 'ses_3', 'ses_4'])
  // 没超上限：原样返回（不复制、不丢键）
  const small = { ses_1: 'plan' }
  assert.equal(trimAgentMemory(small, 3), small)
})
