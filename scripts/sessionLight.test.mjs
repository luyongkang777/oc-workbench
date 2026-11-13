// 会话状态灯判定回归：node --experimental-strip-types --test scripts/sessionLight.test.mjs
//
// 两类错最容易出：把没连上当成「空闲」（替服务端做了它空闲的承诺），
// 以及 busy/idle 比反了（跑着却亮绿灯，用户以为早就好了）。
import assert from 'node:assert/strict'
import test from 'node:test'

import { isRunning, sessionLight, sessionLightTitle } from '../src/components/sessionLight.ts'

/** 造一个会话条目：busy/idle 比大小决定灯色。 */
const at = (busy, idle, extra = {}) => ({
  id: 'ses_1',
  time: { busy, idle },
  metadata: { source: 'oc-workbench' },
  ...extra,
})

test('busy 比 idle 新 = 正在生成', () => {
  assert.equal(isRunning(at(200, 100)), true)
  assert.equal(sessionLight(at(200, 100), true), 'running')
})

test('idle 比 busy 新 = 空闲绿灯', () => {
  assert.equal(isRunning(at(100, 200)), false)
  assert.equal(sessionLight(at(100, 200), true), 'idle')
})

test('时间字段缺失时判为空闲（坏数据不该把灯点黄）', () => {
  assert.equal(sessionLight({}, true), 'idle')
  assert.equal(sessionLight({ time: {} }, true), 'idle')
})

test('没连上时一律灰：不给「空闲」承诺', () => {
  assert.equal(sessionLight(at(100, 200), false), 'unknown')
  // 正在跑的会话在断开时也不能亮黄，那会让人以为灯是实时的
  assert.equal(sessionLight(at(200, 100), false), 'unknown')
})

test('生成中优先于报错：正在重试时不该显示上一轮的红灯', () => {
  const session = at(200, 100, { metadata: { error: 'boom' } })
  assert.equal(sessionLight(session, true), 'running')
})

test('上一轮报错且现在空闲 = 红灯', () => {
  assert.equal(sessionLight(at(100, 200, { metadata: { error: 'boom' } }), true), 'error')
})

test('每种灯都有中文提示', () => {
  for (const light of ['running', 'idle', 'error', 'unknown']) {
    assert.ok(sessionLightTitle(light).length > 0)
  }
})
