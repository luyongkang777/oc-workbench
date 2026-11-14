// 虚拟滚动纯函数的回归测试：node --experimental-strip-types --test scripts/codeWindow.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LINE_HEIGHT,
  MAX_SCROLL_PX,
  formatBytes,
  cycleIndex,
  isHtmlPath,
  isImagePath,
  isMarkdownPath,
  lineAtScrollTop,
  splitMatches,
  scrollModel,
  scrollTopForLine,
  visibleRange,
} from '../src/components/codeWindow.ts'

test('scrollModel: 普通文件按真实行高铺开', () => {
  const model = scrollModel(100)
  assert.equal(model.scale, 1)
  assert.equal(model.height, 100 * LINE_HEIGHT)
})

test('scrollModel: 行数超过滚动上限时压缩比例，且仍能算到末行', () => {
  const lines = 2_000_000
  const model = scrollModel(lines)
  assert.equal(model.height, MAX_SCROLL_PX)
  assert.ok(model.scale < 1)
  // 滚到底：first 应被夹到末行，而不是越界
  const { first, last } = visibleRange(model.height - 800, 800, lines, model.scale)
  assert.equal(last, lines - 1)
  assert.ok(first <= lines - 1)
})

test('visibleRange: 空文件/单行不会算出负数或越界行', () => {
  for (const total of [0, 1]) {
    const { first, last } = visibleRange(0, 600, total)
    assert.equal(first, 0)
    assert.equal(last, 0)
  }
})

test('visibleRange: scrollTop 超过内容高度时 first 被夹到总行数内', () => {
  const { first, last } = visibleRange(10_000_000, 600, 100)
  assert.equal(first, 99)
  assert.equal(last, 99)
})

test('visibleRange: overscan 不把 first 推成负数', () => {
  const { first } = visibleRange(0, 600, 100)
  assert.equal(first, 0)
})

test('扩展名判断', () => {
  assert.equal(isMarkdownPath('docs/readme.MD'), true)
  assert.equal(isMarkdownPath('a.txt'), false)
  assert.equal(isImagePath('x\\pic.PNG'), true)
  assert.equal(isImagePath('x\\pic.webp'), true)
  assert.equal(isImagePath('x\\pic.gif5'), false)
  assert.equal(isHtmlPath('src/index.html'), true)
  assert.equal(isHtmlPath('legacy\\PAGE.HTM'), true)
  assert.equal(isHtmlPath('xhtml/page.xhtml'), true)
  assert.equal(isHtmlPath('a.txt'), false)
  assert.equal(isHtmlPath('page.html5'), false)
})

test('scrollTopForLine: 首行是 0，越界行夹到可滚动底部', () => {
  assert.equal(scrollTopForLine(1, 600_000, 800), 0)
  assert.equal(scrollTopForLine(300_000, 600_000, 800), (300_000 - 1) * LINE_HEIGHT)
  const bottom = scrollTopForLine(600_000, 600_000, 800)
  assert.equal(bottom, 600_000 * LINE_HEIGHT - 800)
  // 行号超过总行数 / 小于 1：都夹回合法范围
  assert.equal(scrollTopForLine(9_999_999, 100, 800), 100 * LINE_HEIGHT - 800)
  assert.equal(scrollTopForLine(-5, 100, 800), 0)
})

test('scrollTopForLine: 压缩映射下也能落到对应行', () => {
  const lines = 2_000_000
  const model = scrollModel(lines)
  const top = scrollTopForLine(1_000_000, lines, 800, model.scale)
  assert.ok(top > 0 && top < model.height)
})

test('lineAtScrollTop: 顶部/中间/越界与压缩映射', () => {
  assert.equal(lineAtScrollTop(0, 100), 1)
  assert.equal(lineAtScrollTop(19 * 10, 100), 11)
  assert.equal(lineAtScrollTop(10_000_000, 100), 100)
  assert.equal(lineAtScrollTop(0, 0), 1)

  const lines = 2_000_000
  const model = scrollModel(lines)
  const last = lineAtScrollTop(model.height - 800, lines, model.scale)
  assert.ok(last > lines - 100 && last <= lines)
})

test('splitMatches: 多处命中 / 大小写 / 无命中', () => {
  assert.deepEqual(splitMatches('foo BAR foo', 'foo'), [
    { text: 'foo', match: true },
    { text: ' BAR ', match: false },
    { text: 'foo', match: true },
  ])
  assert.deepEqual(splitMatches('abc', 'zzz'), [{ text: 'abc', match: false }])
  assert.deepEqual(splitMatches('name=END', 'end'), [
    { text: 'name=', match: false },
    { text: 'END', match: true },
  ])
  assert.deepEqual(splitMatches('anything', ''), [{ text: 'anything', match: false }])
})

test('cycleIndex: 下一个/上一个回绕', () => {
  assert.equal(cycleIndex(0, 3, 1), 1)
  assert.equal(cycleIndex(2, 3, 1), 0)
  assert.equal(cycleIndex(0, 3, -1), 2)
  assert.equal(cycleIndex(0, 0, 1), -1)
})

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
})
