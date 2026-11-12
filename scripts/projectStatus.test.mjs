// 项目标签呼吸灯的判定回归：node --experimental-strip-types --test scripts/projectStatus.test.mjs
//
// 这盏灯容易出两类错：将终端会话的 busy 也算成「AI 在跑」（灯一直闪），
// 以及目录比较写严格了（同一个项目因斜杠/大小写不同永远判成空闲）。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isProjectRunning,
  isSessionRunning,
  runningDirectories,
  sameSet,
} from '../src/components/projectStatus.ts'

/** 造一个工作台对话会话。 */
const chat = (directory, busy, idle, extra = {}) => ({
  location: { directory },
  time: { busy, idle },
  metadata: { source: 'oc-workbench', ...extra },
})

test('busy 比 idle 新 = 正在生成', () => {
  assert.equal(isSessionRunning({ time: { busy: 200, idle: 100 } }), true)
})

test('idle 比 busy 新 = 已经跑完', () => {
  assert.equal(isSessionRunning({ time: { busy: 100, idle: 200 } }), false)
})

test('时间字段缺失时判为不跑（坏数据不该把灯点黄）', () => {
  assert.equal(isSessionRunning({}), false)
  assert.equal(isSessionRunning({ time: {} }), false)
})

test('终端会话跑命令不算 AI 在跑', () => {
  const sessions = [chat('F:\\opencode', 200, 100, { kind: 'terminal' })]
  assert.equal(runningDirectories(sessions).size, 0)
})

test('别的工作台标记（CLI/审核脚本）不算 AI 在跑', () => {
  const sessions = [
    { location: { directory: 'F:\\opencode' }, time: { busy: 200, idle: 100 }, metadata: {} },
  ]
  assert.equal(runningDirectories(sessions).size, 0)
})

test('多个会话取「有任一个在跑」', () => {
  const sessions = [
    chat('F:\\opencode', 100, 200),
    chat('F:\\opencode', 300, 200),
    chat('F:\\other', 100, 200),
  ]
  const dirs = runningDirectories(sessions)
  assert.equal(dirs.size, 1)
  assert.ok(dirs.has('f:/opencode'))
})

test('缺 location 的会话跳过，不污染任何项目', () => {
  const sessions = [{ time: { busy: 200, idle: 100 }, metadata: { source: 'oc-workbench' } }]
  assert.equal(runningDirectories(sessions).size, 0)
})

test('目录比较忽略反斜杠、尾分隔符与大小写', () => {
  const dirs = runningDirectories([chat('F:\\Opencode\\', 200, 100)])
  assert.equal(isProjectRunning(dirs, 'f:/opencode'), true)
  assert.equal(isProjectRunning(dirs, 'F:\\opencode'), true)
  assert.equal(isProjectRunning(dirs, 'F:\\opencode\\workbench'), false)
})

test('sameSet：内容一样就算同一份（避免每轮轮询重渲）', () => {
  assert.equal(sameSet(new Set(['a', 'b']), new Set(['b', 'a'])), true)
  assert.equal(sameSet(new Set(['a']), new Set(['a', 'b'])), false)
  assert.equal(sameSet(new Set(), new Set()), true)
})
