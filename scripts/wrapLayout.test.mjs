// 换行布局的回归测试：node --experimental-strip-types --test scripts/wrapLayout.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { LINE_HEIGHT } from '../src/components/codeWindow.ts'
import {
  buildWrapLayout,
  lineAtRow,
  lineAtScrollTop,
  rowOffsetOf,
  scrollTopForLineIn,
  visibleRangeIn,
  wrapRows,
} from '../src/components/wrapLayout.ts'

/** 与实测一致的度量：半角 7.324px、中文 13px（不是 2 倍）。 */
const METRICS = { charWidth: 7.324, wideWidth: 13 }
const TAB4 = METRICS.charWidth * 4

test('wrapRows: 放得下就是 1 行，多一个字符位就换行', () => {
  const m = { charWidth: 10, wideWidth: 20 }
  assert.equal(wrapRows('', 100, m), 1)
  assert.equal(wrapRows('a'.repeat(10), 100, m), 1)
  assert.equal(wrapRows('a'.repeat(11), 100, m), 2)
  assert.equal(wrapRows('a'.repeat(25), 100, m), 3)
})

test('wrapRows: 中文按实测 13px 算，不按「两个半角」算', () => {
  // 262px 宽，每个中文 13px → 20 个刚好放满
  assert.equal(wrapRows('中'.repeat(20), 262, METRICS), 1)
  assert.equal(wrapRows('中'.repeat(21), 262, METRICS), 2)
  // 若按 2×7.324=14.648 估，20 个会算成 2 行；这里必须是 1 行
  assert.notEqual(wrapRows('中'.repeat(20), 262, { charWidth: 7.324, wideWidth: 14.648 }), 1)
})

test('wrapRows: 换行后制表位从行首重新算', () => {
  // 一行只能放 1 个 tab 时：两个 tab 必然占两行
  assert.equal(wrapRows('\t\t', TAB4 * 1.5, METRICS), 2)
  // 行首文字 + tab：tab 要到第 4 列，宽度不够就折行
  assert.equal(wrapRows('ab\t', TAB4 * 0.8, METRICS), 2)
  // 空间充足时是一个 tab 的距离，不会凭空多一行
  assert.equal(wrapRows('ab\t', TAB4 * 4, METRICS), 1)
})

test('wrapRows: 宽度非法时退化成「一行一个字」，不返回 0，也不会死循环', () => {
  assert.equal(wrapRows('abc', 0, METRICS), 3)
  assert.equal(wrapRows('abc', -100, METRICS), 3)
  assert.equal(wrapRows('a'.repeat(50), 0, METRICS), 50)
})

test('wrapRows: 度量缺失时退回保守默认值', () => {
  assert.ok(wrapRows('a'.repeat(100), 100, { charWidth: 0, wideWidth: 0 }) >= 1)
})

test('布局: 未登记的行按 1 行算，登记的行按实际行数累加', () => {
  const layout = buildWrapLayout(10, [
    [0, 3], // 多 2 行
    [2, 2], // 多 1 行
    [2, 4], // 同一行给两次：按最大值去重，不叠加
  ])
  assert.equal(layout.totalRows, 10 + (3 - 1) + (4 - 1))
  assert.equal(rowOffsetOf(layout, 0), 0)
  assert.equal(rowOffsetOf(layout, 1), 3)
  assert.equal(rowOffsetOf(layout, 3), 3 + 2 + 3)
  assert.equal(rowOffsetOf(layout, 10), layout.totalRows)
})

test('布局: 越界的行索引被忽略，不会撑大总高度', () => {
  const layout = buildWrapLayout(3, [
    [-1, 9],
    [3, 9],
    [99, 9],
  ])
  assert.equal(layout.totalRows, 3)
})

test('lineAtRow: 偏移到行号可以反查，行首与行尾落在同一行', () => {
  const layout = buildWrapLayout(6, [
    [1, 4],
    [3, 2],
  ])
  // offsets: 0→0, 1→1, 2→5, 3→6, 4→8, 5→9
  assert.equal(lineAtRow(layout, 0), 0)
  assert.equal(lineAtRow(layout, 1), 1)
  assert.equal(lineAtRow(layout, 4), 1)
  assert.equal(lineAtRow(layout, 5), 2)
  assert.equal(lineAtRow(layout, 6), 3)
  assert.equal(lineAtRow(layout, 8), 4)
  assert.equal(lineAtRow(layout, 100), 5)
})

test('lineAtScrollTop: 换行后滚动位置对应的行号（1 基）', () => {
  const layout = buildWrapLayout(6, [[1, 4]])
  assert.equal(lineAtScrollTop(layout, 0), 1)
  assert.equal(lineAtScrollTop(layout, LINE_HEIGHT * 4), 2)
  assert.equal(lineAtScrollTop(layout, LINE_HEIGHT * 5), 3)
})

test('visibleRangeIn: 覆盖视口首尾，并带 overscan 上下扩', () => {
  const layout = buildWrapLayout(500, [])
  const { first, last } = visibleRangeIn(layout, LINE_HEIGHT * 300, LINE_HEIGHT * 10)
  assert.ok(first < 300)
  assert.ok(last > 310)
  assert.ok(first >= 0 && last <= 499)
})

test('scrollTopForLineIn: 目标行贴顶，且不超出可滚动范围', () => {
  const layout = buildWrapLayout(100, [[10, 20]])
  const top = scrollTopForLineIn(layout, 11, 800)
  assert.equal(top, rowOffsetOf(layout, 10) * LINE_HEIGHT)
  // 末行：夹到 height - viewport
  const end = scrollTopForLineIn(layout, 100, 800)
  assert.ok(end <= layout.height - 800 + 0.001)
  assert.ok(end >= 0)
})

test('大文件: 视觉行超上限时压缩比例，仍能滚到末行', () => {
  const lines = 2_000_000
  const layout = buildWrapLayout(lines, [[0, 50]])
  assert.ok(layout.scale < 1)
  const { last } = visibleRangeIn(layout, layout.height - 800, 800)
  assert.equal(last, lines - 1)
})

test('buildWrapLayout: 自定义行高（审查面板用 18px）', () => {
  const layout = buildWrapLayout(10, [[0, 3]], 18)
  assert.equal(layout.lineHeight, 18)
  assert.equal(layout.totalRows, 12)
  assert.equal(layout.height, 12 * 18)
  // 视口首行：18px * 3 落在第 1 行（0 基）的多出来的那几行里
  const { first } = visibleRangeIn(layout, 18 * 3, 180)
  assert.equal(first, 0)
})

test('buildWrapLayout: 默认行高保持 19（文件查看器）', () => {
  const layout = buildWrapLayout(10, [[0, 2]])
  assert.equal(layout.lineHeight, LINE_HEIGHT)
  assert.equal(layout.height, 11 * LINE_HEIGHT)
})

test('buildWrapLayout: 自定义行高同样受滚动高度上限约束', () => {
  const layout = buildWrapLayout(2_000_000, [[0, 100]], 18)
  assert.ok(layout.scale < 1)
  assert.ok(layout.height <= 16_000_000)
})
