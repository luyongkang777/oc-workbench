// 提交图形树布局的回归测试（契约 §2 / §6）：
// node --experimental-strip-types --test scripts/graphLayout.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { layoutGraph, PALETTE_SIZE } from '../src/components/git/graphLayout.ts'

/** 造一个 GitCommit；只关心布局用的 hash / parents，其余字段给合法默认值。 */
function c(hash, parents = [], extra = {}) {
  return {
    hash,
    short: hash.slice(0, 7),
    parents,
    message: `提交 ${hash}`,
    author: 'tester',
    time: 1_700_000_000,
    isHead: false,
    tags: [],
    refs: [],
    unpushed: false,
    ...extra,
  }
}

/** 连线期望值：颜色永远取来源 lane 的稳定色。 */
function e(from, to) {
  return { from, to, color: from % PALETTE_SIZE }
}

const lanesOf = (rows) => rows.map((r) => r.lane)
const colorsOf = (rows) => rows.map((r) => r.color)
const countsOf = (rows) => rows.map((r) => r.laneCount)
const edgesOf = (rows) => rows.map((r) => r.edges)

/* ---------- 契约 §6 的必备用例 ---------- */

test('直线：单分支 3 个提交，每行都在 lane 0，从第二行起各有一条直连', () => {
  const rows = layoutGraph([c('C', ['B']), c('B', ['A']), c('A')])

  assert.equal(rows.length, 3)
  assert.deepEqual(lanesOf(rows), [0, 0, 0])
  assert.deepEqual(colorsOf(rows), [0, 0, 0])
  assert.deepEqual(countsOf(rows), [1, 1, 1])
  // 第一行没有上家，所以没有线；之后每行都是 lane0 → lane0 的竖线段
  assert.deepEqual(edgesOf(rows), [[], [e(0, 0)], [e(0, 0)]])
  // 输出顺序与输入一致，根提交在最后
  assert.deepEqual(
    rows.map((r) => r.commit.hash),
    ['C', 'B', 'A'],
  )
})

test('菱形：分叉再合并，汇合行不重复开 lane，两条边都连回主线', () => {
  // M 同时开了 A / B 两条分支，A、B 又在 F 汇合
  const rows = layoutGraph([
    c('M', ['A', 'B']),
    c('A', ['F']),
    c('B', ['F']),
    c('F', ['R']),
    c('R'),
  ])

  assert.deepEqual(
    rows.map((r) => r.commit.hash),
    ['M', 'A', 'B', 'F', 'R'],
  )
  // M 开两条 lane；A 走 lane0；B 在 lane1；F 收回到 lane0
  assert.deepEqual(lanesOf(rows), [0, 0, 1, 0, 0])
  assert.deepEqual(colorsOf(rows), [0, 0, 1, 0, 0])
  // 汇合行 F 只需要 1 条 lane——右边那条被收掉了，不留悬空竖线
  assert.deepEqual(countsOf(rows), [2, 2, 2, 1, 1])

  assert.deepEqual(edgesOf(rows)[0], [])
  // A 行：自己的 lane0 连进来；lane1 是 M 刚开出来的分支，
  // 线必须从 lane0 斜过去（e(0,1)），不能从上方凭空悬下来
  assert.deepEqual(edgesOf(rows)[1], [e(0, 0), e(0, 1)])
  // B 行：lane0 上的 F 继续直走，lane1 自己被消费
  assert.deepEqual(edgesOf(rows)[2], [e(0, 0), e(1, 1)])
  // F 行：两条分支同时连到 lane0（这是真正的汇合点）
  assert.deepEqual(edgesOf(rows)[3], [e(0, 0), e(1, 0)])
  assert.deepEqual(edgesOf(rows)[4], [e(0, 0)])
})

test('两个并行分支：lane 0 / lane 1 各走各的，互不串色', () => {
  //    M
  //   / \
  //  X   Y        ← 两个分支头各带一个提交
  //  |   |
  //  X2  Y2
  //   \ /
  //    R
  const rows = layoutGraph([
    c('M', ['X', 'Y']),
    c('X', ['X2']),
    c('X2', ['R']),
    c('Y', ['Y2']),
    c('Y2', ['R']),
    c('R'),
  ])

  assert.deepEqual(lanesOf(rows), [0, 0, 0, 1, 1, 0])
  // lane0 的三行全是 0 号色，lane1 的两行全是 1 号色
  assert.deepEqual(colorsOf(rows), [0, 0, 0, 1, 1, 0])
  assert.deepEqual(countsOf(rows), [2, 2, 2, 2, 2, 1])

  // 首行之后的第 1 行是分叉口：lane1 由 M 刚开出来，线从 lane0 斜过去
  assert.deepEqual(edgesOf(rows)[1], [e(0, 0), e(0, 1)])
  // 之后两条 lane 各自直走
  for (let i = 2; i < 5; i += 1) {
    assert.deepEqual(edgesOf(rows)[i], [e(0, 0), e(1, 1)])
  }
  // 最后一行两条分支汇合进 lane0
  assert.deepEqual(edgesOf(rows)[5], [e(0, 0), e(1, 0)])
})

test('根提交（parents: []）不崩，独占 lane 0', () => {
  const rows = layoutGraph([c('R', [])])

  assert.equal(rows.length, 1)
  assert.equal(rows[0].lane, 0)
  assert.equal(rows[0].color, 0)
  assert.deepEqual(rows[0].edges, [])
  assert.equal(rows[0].laneCount, 1)
  assert.equal(rows[0].commit.hash, 'R')
})

test('父提交不在列表里（被 limit 截断）不崩，那条 lane 一直空等', () => {
  // 只有最新的一个提交，它的父在列表外
  const single = layoutGraph([c('A', ['MISSING'])])
  assert.deepEqual(lanesOf(single), [0])
  assert.deepEqual(edgesOf(single), [[]])
  assert.deepEqual(countsOf(single), [1])

  // 列表里还有一个别的根提交：被截断的 lane0 一直占着，根提交只能用 lane1
  const rows = layoutGraph([c('B', ['MISSING']), c('A')])
  assert.deepEqual(lanesOf(rows), [0, 1])
  assert.deepEqual(countsOf(rows), [1, 2])
  assert.deepEqual(edgesOf(rows), [[], [e(0, 0)]])
})

test('空数组 → 空数组，不抛错', () => {
  assert.deepEqual(layoutGraph([]), [])
  // 防御式：null / undefined 也当空处理，别把渲染层炸掉
  assert.deepEqual(layoutGraph(null), [])
  assert.deepEqual(layoutGraph(undefined), [])
})

test('空位复用：分支结束后，后来的提交能占回 lane 0', () => {
  // C 开了 A(0) / B(1) 两个分支，两个都是根提交（直接终止），
  // 之后又出现一个独立提交 D —— 它应该回收空的 lane0，而不是往右新开 lane2
  const rows = layoutGraph([c('C', ['A', 'B']), c('A'), c('B'), c('D')])

  assert.deepEqual(lanesOf(rows), [0, 0, 1, 0])
  assert.deepEqual(countsOf(rows), [2, 2, 2, 1])
  assert.deepEqual(edgesOf(rows)[2], [e(1, 1)])
  assert.deepEqual(edgesOf(rows)[3], [])
})

/* ---------- 任务追加的用例 ---------- */

test('三个分支并行展开，再依次合并', () => {
  // M 同时开了三条分支 A / B / C，三者都指向同一个 R
  const rows = layoutGraph([
    c('M', ['A', 'B', 'C']),
    c('A', ['R']),
    c('B', ['R']),
    c('C', ['R']),
    c('R'),
  ])

  assert.deepEqual(lanesOf(rows), [0, 0, 1, 2, 0])
  assert.deepEqual(colorsOf(rows), [0, 0, 1, 2, 0])
  // M 行三条 lane 全开；合并完成后只需要 1 条
  assert.deepEqual(countsOf(rows), [3, 3, 3, 3, 1])

  assert.deepEqual(edgesOf(rows)[0], [])
  // A 行：自己连进来，另外两条是 M 刚开的分支，都从 lane0 斜出去
  assert.deepEqual(edgesOf(rows)[1], [e(0, 0), e(0, 1), e(0, 2)])
  assert.deepEqual(edgesOf(rows)[2], [e(0, 0), e(1, 1), e(2, 2)])
  // C 行：lane0、lane1 已经都变成 R 了，两根线一起斜向右边
  assert.deepEqual(edgesOf(rows)[3], [e(0, 0), e(1, 0), e(2, 2)])
  // R 行：三条分支同时汇进 lane0
  assert.deepEqual(edgesOf(rows)[4], [e(0, 0), e(1, 0), e(2, 0)])
})

test('同一个父被两个子引用：fork 后两条分支指向同一提交，汇合时只剩一条 lane', () => {
  // A、B 是两个分支头（没有合并提交），父都是 P
  const rows = layoutGraph([c('A', ['P']), c('B', ['P']), c('P')])

  assert.deepEqual(lanesOf(rows), [0, 1, 0])
  assert.deepEqual(colorsOf(rows), [0, 1, 0])
  // B 行：lane0 还在等 P（直走），lane1 是新开的
  assert.deepEqual(countsOf(rows), [1, 2, 1])
  assert.deepEqual(edgesOf(rows), [[], [e(0, 0)], [e(0, 0), e(1, 0)]])
})

test('单提交仓库：根提交一行搞定', () => {
  const rows = layoutGraph([c('only-child', [])])

  assert.equal(rows.length, 1)
  assert.equal(rows[0].lane, 0)
  assert.equal(rows[0].laneCount, 1)
  assert.deepEqual(rows[0].edges, [])
  assert.equal(rows[0].commit.short, 'only-ch')
})

test('100 个线性提交：始终 lane 0，laneCount 1，性能不炸', () => {
  const commits = []
  for (let i = 0; i < 100; i += 1) {
    const parents = i === 99 ? [] : [`c${i + 1}`]
    commits.push(c(`c${i}`, parents))
  }

  const started = Date.now()
  const rows = layoutGraph(commits)
  const elapsed = Date.now() - started

  assert.equal(rows.length, 100)
  assert.deepEqual(
    lanesOf(rows),
    Array.from({ length: 100 }, () => 0),
  )
  assert.deepEqual(
    countsOf(rows),
    Array.from({ length: 100 }, () => 1),
  )
  assert.deepEqual(rows[0].edges, [])
  for (let i = 1; i < 100; i += 1) {
    assert.deepEqual(rows[i].edges, [e(0, 0)])
  }
  // 100 行纯线性扫描，宽松上限：真出现 O(n²) 的写法也不会慢到 1 秒
  assert.ok(elapsed < 1000, `布局耗时 ${elapsed}ms，超过线性扫描的预期`)
})

/* ---------- 补充：颜色回绕与字段缺失 ---------- */

test('颜色按 lane % PALETTE_SIZE 回绕：第 7 条 lane 回到 0 号色', () => {
  const parents = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']
  const rows = layoutGraph([c('O', parents), ...parents.map((h) => c(h))])

  assert.equal(PALETTE_SIZE, 6)
  // 七根 lane 依次占 0..6，没有 splice 挤位
  assert.deepEqual(lanesOf(rows), [0, 0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(countsOf(rows), [7, 7, 7, 7, 7, 7, 7, 7])
  assert.deepEqual(colorsOf(rows), [0, 0, 1, 2, 3, 4, 5, 0])

  // 第 7 条 lane（index 6）的线颜色也回绕成 0。
  // 行 1 是「分叉后的第一行」：主线绕回 0 号色，同时 6 条新开的分支
  // 必须全部从 lane 0 斜出去——不能从上方凭空悬下来。
  assert.deepEqual(edgesOf(rows)[1], [
    e(0, 0),
    e(0, 1),
    e(0, 2),
    e(0, 3),
    e(0, 4),
    e(0, 5),
    e(0, 6),
  ])
  assert.deepEqual(edgesOf(rows)[7], [{ from: 6, to: 6, color: 0 }])
})

test('后端还没补 parents 字段时，当根提交处理，不抛错', () => {
  const legacy = { hash: 'L', short: 'L', message: '旧数据', author: 'a', time: 1, isHead: false, tags: [] }
  const rows = layoutGraph([legacy, c('A')])

  assert.equal(rows.length, 2)
  // 两条互不相关的根提交：第一条结束后 lane0 被裁掉，第二条重新从 lane0 开始
  assert.deepEqual(lanesOf(rows), [0, 0])
  assert.deepEqual(edgesOf(rows), [[], []])
})
