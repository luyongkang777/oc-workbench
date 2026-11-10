// diff 虚拟滚动窗口的回归测试：node --experimental-strip-types --test scripts/diffWindow.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { DIFF_LINE_HEIGHT, DIFF_OVERSCAN, diffWindow } from '../src/components/diffWindow.ts'

test('空 patch 返回全 0', () => {
  assert.deepEqual(diffWindow(0, 0, 600), { first: 0, last: 0, offset: 0, height: 0 })
})

test('内容比视口短时全部渲染', () => {
  const win = diffWindow(10, 0, 600)
  assert.equal(win.first, 0)
  assert.equal(win.last, 10)
  assert.equal(win.height, 10 * DIFF_LINE_HEIGHT)
})

test('滚到中间只渲染视口附近的窗口', () => {
  const total = 60000
  const scrollTop = 30000 * DIFF_LINE_HEIGHT
  const win = diffWindow(total, scrollTop, 600)
  assert.equal(win.first, 30000 - DIFF_OVERSCAN)
  assert.ok(win.last < total)
  assert.ok(win.last - win.first < 120)
  assert.equal(win.offset, win.first * DIFF_LINE_HEIGHT)
})

test('滚动越界被夹住，last 不超过总行数', () => {
  const total = 100
  const bottom = diffWindow(total, 10 ** 9, 600)
  assert.equal(bottom.last, total)
  assert.ok(bottom.first < total)
  // scrollTop 为负（回弹）也不出负数
  const top = diffWindow(total, -500, 600)
  assert.equal(top.first, 0)
})

test('超大视口也不会算出超过总行数的 last', () => {
  const win = diffWindow(50, 0, 100000)
  assert.equal(win.last, 50)
})
