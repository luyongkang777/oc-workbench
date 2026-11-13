// 查看区缩放的回归测试：node --experimental-strip-types --test scripts/viewZoom.test.mjs
//
// 只测纯函数（取值/取整/持久化/滚轮换算）；DOM 层怎么用 zoom 由实测覆盖
// （关键结论：zoom 加在滚动容器上时所有测量值仍是布局像素，见 viewZoom.ts 注释）。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  VIEW_ZOOM,
  ZOOM_STEP,
  clampZoom,
  readViewZoom,
  stepZoom,
  writeViewZoom,
  zoomFromWheel,
  zoomLabel,
} from '../src/components/viewZoom.ts'

// localStorage 的极简替身：node 里没有 window，纯函数要能脱环境跑
function withStorage(store) {
  const saved = globalThis.window
  globalThis.window = {
    localStorage: {
      getItem: (key) => (Object.hasOwn(store, key) ? store[key] : null),
      setItem: (key, value) => {
        store[key] = String(value)
      },
    },
  }
  return () => {
    if (saved === undefined) delete globalThis.window
    else globalThis.window = saved
  }
}

test('clampZoom: 越界夹回区间，非法值回默认', () => {
  assert.equal(clampZoom(0.1), VIEW_ZOOM.min)
  assert.equal(clampZoom(99), VIEW_ZOOM.max)
  assert.equal(clampZoom(Number.NaN), VIEW_ZOOM.def)
  assert.equal(clampZoom(Number.POSITIVE_INFINITY), VIEW_ZOOM.def)
  assert.equal(clampZoom(1.5), 1.5)
})

test('clampZoom: 消掉 0.1 累加的浮点误差', () => {
  let value = 1
  for (let i = 0; i < 3; i += 1) value += 0.1
  // 1.3000000000000003 这种不能漏到 UI 上
  assert.equal(clampZoom(value), 1.3)
  assert.equal(zoomLabel(clampZoom(value)), '130%')
})

test('stepZoom: 每次加减一档，到边界停住不绕圈', () => {
  assert.equal(stepZoom(1, 1), 1 + ZOOM_STEP)
  assert.equal(stepZoom(1, -1), 1 - ZOOM_STEP)
  assert.equal(stepZoom(VIEW_ZOOM.max, 1), VIEW_ZOOM.max)
  assert.equal(stepZoom(VIEW_ZOOM.min, -1), VIEW_ZOOM.min)
})

test('stepZoom: 连续加 30 次仍不越界、也不出现浮点尾巴', () => {
  let value = VIEW_ZOOM.def
  for (let i = 0; i < 30; i += 1) value = stepZoom(value, 1)
  assert.equal(value, VIEW_ZOOM.max)
  assert.equal(String(value), '4')
})

test('zoomFromWheel: 只认方向不认幅度（触控板连发不会一滑到底）', () => {
  assert.equal(zoomFromWheel(1, -1), 1 + ZOOM_STEP)
  assert.equal(zoomFromWheel(1, -120), 1 + ZOOM_STEP)
  assert.equal(zoomFromWheel(1, 1), 1 - ZOOM_STEP)
  assert.equal(zoomFromWheel(1, 120), 1 - ZOOM_STEP)
  assert.equal(zoomFromWheel(1, 0), 1)
})

test('zoomLabel: 百分比取整，边界正常', () => {
  assert.equal(zoomLabel(1), '100%')
  assert.equal(zoomLabel(0.5), '50%')
  assert.equal(zoomLabel(1.25), '125%')
  assert.equal(zoomLabel(4), '400%')
})

test('readViewZoom/writeViewZoom: 按项目根各记一份，新项目沿用最近一次', () => {
  const store = {}
  const restore = withStorage(store)
  try {
    assert.equal(readViewZoom('F:\\a'), VIEW_ZOOM.def)
    writeViewZoom('F:\\a', 1.5)
    assert.equal(readViewZoom('F:\\a'), 1.5)
    // 没记过的项目：沿用全局最近值
    assert.equal(readViewZoom('F:\\b'), 1.5)
    writeViewZoom('F:\\b', 2)
    assert.equal(readViewZoom('F:\\a'), 1.5)
    assert.equal(readViewZoom('F:\\b'), 2)
  } finally {
    restore()
  }
})

test('文本与图片各记一套：调大代码不会把图片弄成非适应', () => {
  const store = {}
  const restore = withStorage(store)
  try {
    writeViewZoom('F:\\p', 1.5, 'text')
    assert.equal(readViewZoom('F:\\p', 'text'), 1.5)
    // 图片没调过，仍是默认 100%
    assert.equal(readViewZoom('F:\\p', 'image'), VIEW_ZOOM.def)
    writeViewZoom('F:\\p', 2, 'image')
    assert.equal(readViewZoom('F:\\p', 'image'), 2)
    assert.equal(readViewZoom('F:\\p', 'text'), 1.5)
  } finally {
    restore()
  }
})

test('老版本只存过一套比例：文本沿用，图片从 100% 起', () => {
  const store = { 'oc-workbench:view-zoom:F:\\legacy': '1.8' }
  const restore = withStorage(store)
  try {
    assert.equal(readViewZoom('F:\\legacy', 'text'), 1.8)
    assert.equal(readViewZoom('F:\\legacy', 'image'), VIEW_ZOOM.def)
  } finally {
    restore()
  }
})

test('readViewZoom: 存的值越界/是脏数据时退回默认，不抛错', () => {
  const store = { 'oc-workbench:view-zoom:F:\\c': 'abc' }
  const restore = withStorage(store)
  try {
    assert.equal(readViewZoom('F:\\c'), VIEW_ZOOM.def)
    store['oc-workbench:view-zoom:F:\\c'] = '99'
    assert.equal(readViewZoom('F:\\c'), VIEW_ZOOM.max)
  } finally {
    restore()
  }
})

test('writeViewZoom: localStorage 抛异常时静默失败（隐私模式下仍能用）', () => {
  const saved = globalThis.window
  globalThis.window = {
    localStorage: {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    },
  }
  try {
    assert.equal(readViewZoom('F:\\d'), VIEW_ZOOM.def)
    assert.doesNotThrow(() => writeViewZoom('F:\\d', 2))
  } finally {
    if (saved === undefined) delete globalThis.window
    else globalThis.window = saved
  }
})
