// 运行时前缀的回归测试：node --experimental-strip-types --test scripts/remoteBase.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { computeBase, remoteTokenKey, withBase } from '../src/api/base.ts'

test('computeBase：从页面地址推出前缀', () => {
  assert.equal(computeBase('/'), '')
  assert.equal(computeBase('/u/abc/'), '/u/abc')
  assert.equal(computeBase('/u/abc'), '/u/abc')
  assert.equal(computeBase('/u/abc/index.html'), '/u/abc')
  assert.equal(computeBase('/u/abcd/'), '/u/abcd')
})

test('withBase：只改内部路径', () => {
  assert.equal(withBase('/api/info', '/u/abc/'), '/u/abc/api/info')
  assert.equal(withBase('/local/fs/list?x=1', '/u/abc/'), '/u/abc/local/fs/list?x=1')
  assert.equal(withBase('/api', '/u/abc/'), '/u/abc/api')
  assert.equal(withBase('/assets/x.js', '/u/abc/'), '/assets/x.js')
  assert.equal(withBase('https://example.com/api', '/u/abc/'), 'https://example.com/api')
  assert.equal(withBase('//cdn.example.com/x', '/u/abc/'), '//cdn.example.com/x')
})

test('withBase：根路径下保持原样', () => {
  assert.equal(withBase('/api/info', '/'), '/api/info')
})

test('withBase：不误匹配同前缀的邻居', () => {
  assert.equal(withBase('/apiary', '/u/abc/'), '/apiary')
  assert.equal(withBase('/localfs', '/u/abc/'), '/localfs')
})

test(
  'remoteTokenKey：按前缀隔离，避免同入口多个实例互相覆盖',
  () => {
    assert.equal(remoteTokenKey('/u/abc/'), 'oc-workbench:remote-token:/u/abc')
    assert.equal(remoteTokenKey('/u/xyz/'), 'oc-workbench:remote-token:/u/xyz')
    assert.equal(remoteTokenKey('/'), 'oc-workbench:remote-token:')
  },
)
