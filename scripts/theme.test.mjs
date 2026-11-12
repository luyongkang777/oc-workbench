// 主题偏好的回归测试：node --experimental-strip-types --test scripts/theme.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_THEME_PREF,
  nextThemePref,
  parseThemePref,
  resolveTheme,
  themeIcon,
  themeLabel,
  themeTitle,
} from '../src/components/theme.ts'

test('parseThemePref: 合法值原样保留，旧值/脏值退回跟随系统', () => {
  assert.equal(parseThemePref('dark'), 'dark')
  assert.equal(parseThemePref('light'), 'light')
  assert.equal(parseThemePref('system'), 'system')
  assert.equal(parseThemePref(null), DEFAULT_THEME_PREF)
  assert.equal(parseThemePref(''), DEFAULT_THEME_PREF)
  assert.equal(parseThemePref('purple'), DEFAULT_THEME_PREF)
})

test('resolveTheme: 跟随系统看系统深浅，强制态不看', () => {
  assert.equal(resolveTheme('system', true), 'dark')
  assert.equal(resolveTheme('system', false), 'light')
  assert.equal(resolveTheme('dark', false), 'dark')
  assert.equal(resolveTheme('light', true), 'light')
})

test('nextThemePref: 三态轮换一圈回到原点', () => {
  let pref = 'system'
  const seen = [pref]
  for (let i = 0; i < 3; i += 1) {
    pref = nextThemePref(pref)
    seen.push(pref)
  }
  assert.deepEqual(seen, ['system', 'dark', 'light', 'system'])
})

test('themeIcon: 跟随系统用显示器，强制态按解析结果给太阳/月亮', () => {
  assert.equal(themeIcon('system', 'dark'), 'monitor')
  assert.equal(themeIcon('system', 'light'), 'monitor')
  assert.equal(themeIcon('dark', 'dark'), 'moon')
  assert.equal(themeIcon('light', 'light'), 'sun')
})

test('themeTitle: 说清当前状态和下一次点击', () => {
  assert.match(themeTitle('system', 'dark'), /跟随系统.*暗色/)
  assert.match(themeTitle('dark', 'dark'), /暗色/)
  assert.match(themeTitle('light', 'light'), /浅白/)
})

test('themeLabel: 浮层短提示（快捷键切换后用）', () => {
  assert.equal(themeLabel('system', 'dark'), '跟随系统（当前暗色）')
  assert.equal(themeLabel('system', 'light'), '跟随系统（当前浅白）')
  assert.equal(themeLabel('dark', 'dark'), '暗色')
  assert.equal(themeLabel('light', 'light'), '浅白')
})
