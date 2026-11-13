// 页面可见性工具（轮询节流的基础）。
// node --experimental-strip-types --test scripts/visibility.test.mjs
//
// 没有 document 的环境（node 单测、SSR）必须当作「可见」，否则轮询会被永久跳过。
import assert from 'node:assert/strict'
import test from 'node:test'

import { onPageVisible, pageVisible } from '../src/api/visibility.ts'

test('没有 document 时按可见处理', () => {
  assert.equal(typeof document, 'undefined')
  assert.equal(pageVisible(), true)
})

test('没有 document 时注册可见回调是安全的空操作', () => {
  const off = onPageVisible(() => {
    throw new Error('不该被调用')
  })
  assert.equal(typeof off, 'function')
  off()
})
