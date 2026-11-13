// git 面板格式化函数的回归测试：
// node --experimental-strip-types --test scripts/gitFormat.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  describePushResult,
  relativeTime,
  statusLabel,
  statusTone,
  summarizeChanges,
  syncLabel,
} from '../src/components/git/gitFormat.ts'

const NOW = 1_700_000_000 // 固定基准，别让测试随系统时间漂

test('statusLabel: 六种状态都有中文名', () => {
  assert.equal(statusLabel('added'), '新增')
  assert.equal(statusLabel('modified'), '修改')
  assert.equal(statusLabel('deleted'), '删除')
  assert.equal(statusLabel('untracked'), '未跟踪')
  assert.equal(statusLabel('renamed'), '重命名')
  assert.equal(statusLabel('conflicted'), '冲突')
})

test('statusTone: 状态到颜色档位', () => {
  assert.equal(statusTone('added'), 'add')
  assert.equal(statusTone('modified'), 'mod')
  assert.equal(statusTone('renamed'), 'mod')
  assert.equal(statusTone('deleted'), 'del')
  assert.equal(statusTone('untracked'), 'new')
  assert.equal(statusTone('conflicted'), 'conflict')
})

test('relativeTime: 一分钟内算刚刚', () => {
  assert.equal(relativeTime(NOW, NOW), '刚刚')
  assert.equal(relativeTime(NOW - 1, NOW), '刚刚')
  assert.equal(relativeTime(NOW - 59, NOW), '刚刚')
})

test('relativeTime: 分钟档的边界（59 秒 / 60 秒 / 3599 秒 / 3600 秒）', () => {
  assert.equal(relativeTime(NOW - 59, NOW), '刚刚')
  assert.equal(relativeTime(NOW - 60, NOW), '1 分钟前')
  assert.equal(relativeTime(NOW - 61, NOW), '1 分钟前')
  assert.equal(relativeTime(NOW - 3599, NOW), '59 分钟前')
  assert.equal(relativeTime(NOW - 3600, NOW), '1 小时前')
})

test('relativeTime: 跨小时与跨天', () => {
  assert.equal(relativeTime(NOW - 3600, NOW), '1 小时前')
  assert.equal(relativeTime(NOW - 7200, NOW), '2 小时前')
  assert.equal(relativeTime(NOW - 86399, NOW), '23 小时前')
  assert.equal(relativeTime(NOW - 86400, NOW), '1 天前')
  assert.equal(relativeTime(NOW - 86400 * 2 - 5, NOW), '2 天前')
})

test('relativeTime: 30 天仍说天前，超过 30 天给日期', () => {
  assert.equal(relativeTime(NOW - 86400 * 30, NOW), '30 天前')

  const old = NOW - 86400 * 31
  const expected = relativeTime(old, NOW)
  assert.match(expected, /^\d{4}-\d{2}-\d{2}$/)

  // 日期按本地时区渲染：用同一个 Date 算出来的年月日做期望，避免时区差异
  const date = new Date(old * 1000)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  assert.equal(expected, `${date.getFullYear()}-${month}-${day}`)
})

test('relativeTime: 未来时间与非法值', () => {
  // 时钟偏差导致的未来时间不能变成负数
  assert.equal(relativeTime(NOW + 600, NOW), '刚刚')
  assert.equal(relativeTime(0, NOW), '')
  assert.equal(relativeTime(-5, NOW), '')

  assert.equal(relativeTime(Number.NaN, NOW), '')
  assert.equal(relativeTime(Number.POSITIVE_INFINITY, NOW), '')
})

test('syncLabel: 已同步 / 单向 / 双向分叉', () => {
  assert.equal(syncLabel(0, 0), '已同步')
  assert.equal(syncLabel(3, 0), '领先 3 个提交')
  assert.equal(syncLabel(0, 2), '落后 2 个提交')
  assert.equal(syncLabel(2, 1), '领先 2 个提交，落后 1 个提交')
})

test('syncLabel: 没有上游分支', () => {
  assert.equal(syncLabel(0, 0, true), '还没关联远程分支')
  // noUpstream 优先，领先落后不当回事
  assert.equal(syncLabel(5, 5, true), '还没关联远程分支')
})

test('syncLabel: 负数与小数按 0 / 整数处理', () => {
  assert.equal(syncLabel(-3, -2), '已同步')
  assert.equal(syncLabel(-3, 2), '落后 2 个提交')
  assert.equal(syncLabel(2.9, 0), '领先 2 个提交')
})

test('summarizeChanges: 空数组', () => {
  assert.equal(summarizeChanges([]), '没有改动')
})

test('summarizeChanges: 全部未跟踪', () => {
  const files = [
    { path: 'a.txt', status: 'untracked', staged: false, worktreeDirty: false },
    { path: 'b.txt', status: 'untracked', staged: false, worktreeDirty: false },
    { path: 'c.txt', status: 'untracked', staged: false, worktreeDirty: false },
  ]
  assert.equal(summarizeChanges(files), '3 个改动，全部未跟踪')
})

test('summarizeChanges: 混合与零未跟踪', () => {
  assert.equal(
    summarizeChanges([
      { path: 'a.ts', status: 'modified', staged: false, worktreeDirty: false },
      { path: 'b.ts', status: 'untracked', staged: false, worktreeDirty: false },
      { path: 'c.ts', status: 'untracked', staged: false, worktreeDirty: false },
    ]),
    '3 个改动，其中 2 个未跟踪',
  )

  assert.equal(
    summarizeChanges([
      { path: 'a.ts', status: 'modified', staged: false, worktreeDirty: false },
      { path: 'b.ts', status: 'deleted', staged: true, worktreeDirty: false },
    ]),
    '2 个改动',
  )

  // 单个改动也说清楚，不带「其中」
  assert.equal(
    summarizeChanges([{ path: 'a.ts', status: 'added', staged: true, worktreeDirty: false }]),
    '1 个改动',
  )
})

test('describePushResult: 分清「推上去了」和「本来就没东西可推」', () => {
  // 真推了东西：git 输出里是 To <url> + 一行 ref 更新
  assert.equal(
    describePushResult('To http://192.168.31.8:3000/a/b.git\n   1129446..abc1234  main -> main\n', 'main'),
    '已推送到 main',
  )
  // 没东西可推时退出码也是 0，只会写这一句
  assert.equal(
    describePushResult('Everything up-to-date\n', 'main'),
    '远程已经是最新的，没有需要推送的提交',
  )
  // 大小写和空格变体
  assert.equal(describePushResult('EVERYTHING UP-TO-DATE', 'main'), '远程已经是最新的，没有需要推送的提交')
  assert.equal(describePushResult('everything up to date', 'main'), '远程已经是最新的，没有需要推送的提交')
  // 分支名缺失时不能渲染出「已推送到 」
  assert.equal(describePushResult('', ''), '已推送到远程')
  assert.equal(describePushResult('', '   '), '已推送到远程')
  // 带斜杠的分支名原样带上
  assert.equal(describePushResult('', 'feature/graph'), '已推送到 feature/graph')
})
