// 更新进度文案与状态合并的回归。
// node --experimental-strip-types --test scripts/updateProgress.test.mjs
//
// 这条链最容易出的错：
//   1. 进度被后面一次检查/轮询覆盖回去（用户会看到进度条倒退或消失）；
//   2. 总量未知时编一个假百分比；
//   3. 更新成功后还在提示「有新版本」。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  IDLE_TASK,
  backendStillRunning,
  applyButtonText,
  formatBytes,
  mergeProgress,
  taskActive,
  taskPercent,
  taskSettled,
  taskText,
} from '../src/components/updateProgressFormat.ts'

const progress = (stage, done = 0, total = 0, error = null) => ({
  active: stage !== 'idle',
  stage,
  done,
  total,
  percent: total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : null,
  error,
})

test('formatBytes 边界', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(-5), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(2.8 * 1024 * 1024), '2.8 MB')
})

test('taskPercent：总量未知给 null，重启阶段直接 100', () => {
  assert.equal(taskPercent({ ...IDLE_TASK, phase: 'downloading', done: 0, total: 0 }), null)
  assert.equal(taskPercent({ ...IDLE_TASK, phase: 'downloading', done: 512, total: 2048 }), 25)
  // 向下取整，不提前显示 100%
  assert.equal(taskPercent({ ...IDLE_TASK, phase: 'downloading', done: 99, total: 100 }), 99)
  // 超出总量不能出 120%
  assert.equal(taskPercent({ ...IDLE_TASK, phase: 'downloading', done: 300, total: 100 }), 100)
  assert.equal(taskPercent({ ...IDLE_TASK, phase: 'restarting', done: 0, total: 0 }), 100)
})

test('taskText 四个阶段各说一件事', () => {
  assert.equal(
    taskText({ ...IDLE_TASK, phase: 'downloading', done: 1024 * 1024, total: 4 * 1024 * 1024 }),
    '下载中 25% · 1.0 MB / 4.0 MB',
  )
  // 总量未知：只说已下载多少，不给假百分比
  assert.equal(
    taskText({ ...IDLE_TASK, phase: 'downloading', done: 2048, total: 0 }),
    '下载中 · 已下载 2.0 KB',
  )
  assert.equal(taskText({ ...IDLE_TASK, phase: 'verifying' }), '下载完成，正在校验 SHA256…')
  assert.equal(taskText({ ...IDLE_TASK, phase: 'restarting' }), '更新包已就绪，正在重启到新版本…')
  assert.equal(taskText({ ...IDLE_TASK, phase: 'failed', error: 'SHA256 不符' }), 'SHA256 不符')
  assert.equal(taskText(IDLE_TASK), '')
})

test('mergeProgress：下载中正常推进', () => {
  const task = { ...IDLE_TASK, phase: 'downloading' }
  const next = mergeProgress(task, progress('downloading', 2048, 4096))
  assert.equal(next.phase, 'downloading')
  assert.equal(next.done, 2048)
  assert.equal(next.total, 4096)
})

test('mergeProgress：已下载字节只增不减（轮询响应可能乱序）', () => {
  const task = { ...IDLE_TASK, phase: 'downloading', done: 3000, total: 4096 }
  const next = mergeProgress(task, progress('downloading', 1000, 4096))
  assert.equal(next.done, 3000, '旧响不能让进度条往回跳')
})

test('mergeProgress：总量未知时不把已知的 total 冲成 0', () => {
  const task = { ...IDLE_TASK, phase: 'downloading', done: 100, total: 4096 }
  const next = mergeProgress(task, progress('downloading', 200, 0))
  assert.equal(next.total, 4096)
  assert.equal(next.done, 200)
})

test('mergeProgress：restarting 与 failed 是终态，不被后续轮询改回去', () => {
  const ready = { ...IDLE_TASK, phase: 'restarting', done: 4096, total: 4096 }
  assert.deepEqual(mergeProgress(ready, progress('downloading', 100, 4096)), ready)
  assert.deepEqual(mergeProgress(ready, progress('idle')), ready)

  const failed = { ...IDLE_TASK, phase: 'failed', error: '连不上' }
  assert.deepEqual(mergeProgress(failed, progress('downloading', 100, 4096)), failed)
})

test('mergeProgress：外壳回 idle/checking 时不清零本地进度', () => {
  const task = { ...IDLE_TASK, phase: 'downloading', done: 2048, total: 4096 }
  const next = mergeProgress(task, progress('idle'))
  assert.equal(next.phase, 'downloading')
  assert.equal(next.done, 2048)
  assert.equal(next.total, 4096)
})

test('mergeProgress：外壳报失败时带上原因', () => {
  const task = { ...IDLE_TASK, phase: 'downloading', done: 100, total: 4096 }
  const next = mergeProgress(task, progress('failed', 100, 4096, '下载超时'))
  assert.equal(next.phase, 'failed')
  assert.equal(next.error, '下载超时')
})

test('taskActive / taskSettled 判定', () => {
  assert.equal(taskActive(IDLE_TASK), false)
  assert.equal(taskActive({ ...IDLE_TASK, phase: 'downloading' }), true)
  assert.equal(taskActive({ ...IDLE_TASK, phase: 'verifying' }), true)
  assert.equal(taskActive({ ...IDLE_TASK, phase: 'restarting' }), true)
  assert.equal(taskActive({ ...IDLE_TASK, phase: 'failed' }), false)

  assert.equal(taskSettled({ ...IDLE_TASK, phase: 'restarting' }), true)
  assert.equal(taskSettled({ ...IDLE_TASK, phase: 'downloading' }), false)
})

test('applyButtonText 跟着阶段走', () => {
  assert.equal(applyButtonText(IDLE_TASK), '立即更新')
  assert.equal(
    applyButtonText({ ...IDLE_TASK, phase: 'downloading', done: 1, total: 2 }),
    '下载中 50%',
  )
  assert.equal(applyButtonText({ ...IDLE_TASK, phase: 'downloading', done: 1, total: 0 }), '下载中…')
  assert.equal(applyButtonText({ ...IDLE_TASK, phase: 'verifying' }), '校验中…')
  assert.equal(applyButtonText({ ...IDLE_TASK, phase: 'restarting' }), '重启中…')
  assert.equal(applyButtonText({ ...IDLE_TASK, phase: 'failed' }), '重试更新')
})

test('backendStillRunning：决定 apply 失败后要不要继续跟随', () => {
  assert.equal(backendStillRunning(null), false)
  assert.equal(backendStillRunning(progress('downloading', 1, 2)), true)
  assert.equal(backendStillRunning(progress('verifying', 2, 2)), true)
  assert.equal(backendStillRunning(progress('restarting')), true)
  assert.equal(backendStillRunning(progress('failed', 1, 2, 'x')), false)
  assert.equal(backendStillRunning(progress('idle')), false)
  // active=false 的 downloading（后端异常退出）不能算还在跑
  assert.equal(backendStillRunning({ ...progress('downloading', 1, 2), active: false }), false)
})
