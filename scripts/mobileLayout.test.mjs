import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MOBILE_MAX_WIDTH, isMobileWidth, normalizePane } from '../src/hooks/useMobileLayout.ts'

test('手机宽度阈值：800 及以下算手机', () => {
  assert.equal(MOBILE_MAX_WIDTH, 800)
  assert.equal(isMobileWidth(320), true)
  assert.equal(isMobileWidth(390), true)
  assert.equal(isMobileWidth(414), true)
  assert.equal(isMobileWidth(768), true)
  assert.equal(isMobileWidth(800), true)
})

test('手机宽度阈值：801 以上按桌面三栏', () => {
  assert.equal(isMobileWidth(801), false)
  assert.equal(isMobileWidth(1024), false)
  assert.equal(isMobileWidth(1280), false)
})

test('手机横屏（矮屏）也走单列，不然三栏会把编辑器压没', () => {
  assert.equal(isMobileWidth(844, 390), true)
  assert.equal(isMobileWidth(1280, 500), true)
  assert.equal(isMobileWidth(1280, 800), false)
  assert.equal(isMobileWidth(1440, 900), false)
})

test('异常宽度不误判成手机（避免 0/NaN 把桌面切成单列）', () => {
  assert.equal(isMobileWidth(0), false)
  assert.equal(isMobileWidth(-1), false)
  assert.equal(isMobileWidth(Number.NaN), false)
  assert.equal(isMobileWidth(Number.POSITIVE_INFINITY), false)
})

test('未知 pane 值回落到聊天（手机主用途）', () => {
  assert.equal(normalizePane(null), 'chat')
  assert.equal(normalizePane(undefined), 'chat')
  assert.equal(normalizePane(''), 'chat')
  assert.equal(normalizePane('nonsense'), 'chat')
  assert.equal(normalizePane('files'), 'files')
  assert.equal(normalizePane('editor'), 'editor')
  assert.equal(normalizePane('chat'), 'chat')
})
