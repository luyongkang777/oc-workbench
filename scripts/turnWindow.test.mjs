// 轮次窗口化的纯计算测试：node --experimental-strip-types --test scripts/turnWindow.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildOffsets,
  computeWindow,
  indexAt,
  isNearBottom,
} from '../src/components/turnWindow.ts'

const ids = (n) => Array.from({ length: n }, (_, i) => `t${i}`)

test('buildOffsets：没有实测高度时全部按估算值累加', () => {
  const offsets = buildOffsets(ids(3), new Map(), 100)
  assert.deepEqual(offsets, [0, 100, 200, 300])
})

test('buildOffsets：实测值优先，缺失的用估算补', () => {
  const heights = new Map([
    ['t0', 40],
    ['t2', 10],
  ])
  const offsets = buildOffsets(ids(3), heights, 100)
  assert.deepEqual(offsets, [0, 40, 140, 150])
})

test('buildOffsets：0 或负数的高度回退到估算（不能把元素压成 0）', () => {
  const heights = new Map([
    ['t0', 0],
    ['t1', -5],
  ])
  const offsets = buildOffsets(ids(3), heights, 80)
  assert.deepEqual(offsets, [0, 80, 160, 240])
})

test('indexAt：边界与中间位置', () => {
  const offsets = [0, 100, 200, 300]
  assert.equal(indexAt(offsets, 0), 0)
  assert.equal(indexAt(offsets, -50), 0)
  assert.equal(indexAt(offsets, 99), 0)
  assert.equal(indexAt(offsets, 100), 1) // 正好在分界线上算下一轮
  assert.equal(indexAt(offsets, 250), 2)
  assert.equal(indexAt(offsets, 300), 2) // 贴底
  assert.equal(indexAt(offsets, 9999), 2) // 超出总高
})

test('computeWindow：全部可见时不挂 spacer', () => {
  const offsets = [0, 100, 200, 300]
  const win = computeWindow(offsets, 0, 400, 3)
  assert.deepEqual(win, { start: 0, end: 3, topPad: 0, bottomPad: 0 })
})

test('computeWindow：只挂视口附近的轮次', () => {
  const offsets = buildOffsets(ids(100), new Map(), 100) // 每条 100px，总高 10000
  const win = computeWindow(offsets, 5000, 600, 3)
  // 视口 5000~5600 → 覆盖第 50~55 轮，上下各扩 3
  assert.equal(win.start, 47)
  // 5600 正好落在第 56 轮的上边界 → 算进窗口，再往下扩 3
  assert.equal(win.end, 60)
  assert.equal(win.topPad, 4700)
  assert.equal(win.bottomPad, 10000 - 6000)
})

test('computeWindow：spacer 与窗口高度加起来必须等于总高', () => {
  const offsets = buildOffsets(ids(50), new Map(), 120)
  const total = offsets[offsets.length - 1]
  for (const top of [0, 300, 2000, 5900]) {
    const win = computeWindow(offsets, top, 400, 2)
    const windowHeight = offsets[win.end] - offsets[win.start]
    assert.equal(win.topPad + windowHeight + win.bottomPad, total, `top=${top}`)
  }
})

test('computeWindow：overscan 不会越界', () => {
  const offsets = buildOffsets(ids(3), new Map(), 100)
  const head = computeWindow(offsets, 0, 100, 99)
  assert.equal(head.start, 0)
  assert.equal(head.end, 3)

  const tail = computeWindow(offsets, 250, 100, 99)
  assert.equal(tail.start, 0)
  assert.equal(tail.end, 3)
})

test('computeWindow：空列表不产生负高度', () => {
  assert.deepEqual(computeWindow([0], 0, 0, 3), { start: 0, end: 0, topPad: 0, bottomPad: 0 })
  assert.deepEqual(computeWindow([], 0, 0, 3), { start: 0, end: 0, topPad: 0, bottomPad: 0 })
})

test('computeWindow：滚到一半时窗口从中间开始，前面的轮次变成 spacer', () => {
  const offsets = buildOffsets(ids(20), new Map(), 100)
  const win = computeWindow(offsets, 1000, 200, 0)
  assert.equal(win.start, 10)
  assert.equal(win.end, 13)
  assert.equal(win.topPad, 1000)
  assert.equal(win.bottomPad, 2000 - 1300)
})

test('isNearBottom：容差内的亚像素误差也算贴底', () => {
  assert.equal(isNearBottom(900, 100, 1000), true) // 正好到底
  assert.equal(isNearBottom(830, 100, 1000), true) // 差 70，在 80 容差内
  assert.equal(isNearBottom(700, 100, 1000), false)
  assert.equal(isNearBottom(880, 100, 1000, 10), false) // 差 20，收紧容差后不算贴底
})
