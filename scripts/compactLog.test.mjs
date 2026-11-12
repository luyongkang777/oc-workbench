// 压缩记录的回归测试：node --experimental-strip-types --test scripts/compactLog.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_COMPACT_RECORDS,
  appendCompactRecord,
  clearCompactLog,
  compactSummary,
  formatDuration,
  loadCompactLog,
  recordSize,
  shortTime,
} from '../src/components/compactLog.ts'

const SID = 'ses_test'
const keyOf = (sid) => `oc-workbench:compacts:${sid}`

function memStore(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value))
    },
  }
}

const record = (over = {}) => ({
  at: 1000,
  ok: true,
  before: 400_000,
  after: 2_500,
  ms: 3_000,
  ...over,
})

test('没有记录时返回空数组', () => {
  assert.deepEqual(loadCompactLog(SID, memStore()), [])
})

test('追加后能读回，顺序是旧 → 新', () => {
  const store = memStore()
  const first = appendCompactRecord(SID, record({ at: 1 }), store)
  assert.equal(first.length, 1)
  const second = appendCompactRecord(SID, record({ at: 2 }), store)
  assert.deepEqual(second.map((r) => r.at), [1, 2])

  const loaded = loadCompactLog(SID, store)
  assert.deepEqual(loaded.map((r) => r.at), [1, 2])
  assert.equal(loaded[0].before, 400_000)
  assert.equal(loaded[0].after, 2_500)
})

test('超过上限只保留最近 N 条', () => {
  const store = memStore()
  for (let i = 0; i < MAX_COMPACT_RECORDS + 5; i += 1) {
    appendCompactRecord(SID, record({ at: i + 1 }), store)
  }
  const list = loadCompactLog(SID, store)
  assert.equal(list.length, MAX_COMPACT_RECORDS)
  assert.equal(list[0].at, 6)
  assert.equal(list[list.length - 1].at, MAX_COMPACT_RECORDS + 5)
})

test('坏 JSON / 非数组 / 脏字段都不会漏到界面', () => {
  assert.deepEqual(loadCompactLog(SID, memStore({ [keyOf(SID)]: '{not json' })), [])
  assert.deepEqual(loadCompactLog(SID, memStore({ [keyOf(SID)]: '{"a":1}' })), [])

  const dirty = memStore({
    [keyOf(SID)]: JSON.stringify([
      // 类型全错：数字字段归零，ok 只认 true
      { at: 10, ok: 'yes', before: -5, after: 'x', ms: null },
      null,
      { ok: true }, // 没有 at，丢掉
      { at: 20, ok: true, before: 100, after: 5, ms: 800, error: '  boom  ' },
    ]),
  })
  const list = loadCompactLog(SID, dirty)
  assert.equal(list.length, 2)
  assert.deepEqual(list[0], { at: 10, ok: false, before: 0, after: 0, ms: 0 })
  assert.equal(list[1].error, 'boom')
})

test('存储不可用时读空、写不抛', () => {
  assert.deepEqual(loadCompactLog(SID, null), [])
  assert.doesNotThrow(() => appendCompactRecord(SID, record(), null))
  assert.doesNotThrow(() => clearCompactLog(SID, null))
  // 没有 sessionID 也不能写坏仓库
  assert.deepEqual(appendCompactRecord('', record(), memStore()), [record()])
})

test('清空只影响自己的会话', () => {
  const store = memStore()
  appendCompactRecord('ses_a', record(), store)
  appendCompactRecord('ses_b', record(), store)
  clearCompactLog('ses_a', store)
  assert.deepEqual(loadCompactLog('ses_a', store), [])
  assert.equal(loadCompactLog('ses_b', store).length, 1)
})

test('formatDuration：1 秒以内按毫秒，之外按秒', () => {
  assert.equal(formatDuration(0), '—')
  assert.equal(formatDuration(420), '420ms')
  assert.equal(formatDuration(1500), '1.5s')
  assert.equal(formatDuration(12_340), '12.3s')
})

test('shortTime：当天只给时分，跨天补月-日', () => {
  const now = new Date(2026, 10, 12, 20, 0).getTime()
  assert.equal(shortTime(new Date(2026, 10, 12, 18, 49).getTime(), now), '18:49')
  assert.equal(shortTime(new Date(2026, 10, 9, 9, 5).getTime(), now), '11-09 09:05')
})

test('recordSize：成对数字才显示箭头，失败直接写失败', () => {
  assert.equal(recordSize(record()), '400k → 2.5k')
  assert.equal(recordSize(record({ before: 0 })), '已压缩')
  assert.equal(recordSize(record({ ok: false })), '压缩失败')
})

test('compactSummary：次数 + 最近时间 + 最近一次的规模', () => {
  const now = new Date(2026, 10, 12, 20, 0).getTime()
  const at = new Date(2026, 10, 12, 18, 49).getTime()
  assert.equal(compactSummary([], now), '压缩记录')
  assert.equal(
    compactSummary([record({ at }), record({ at, before: 500_000, after: 3_000 })], now),
    '压缩记录 · 2 次 · 最近 18:49（500k → 3k）',
  )
  // 失败记录不带数字，只报时间
  assert.equal(
    compactSummary([record({ at, ok: false })], now),
    '压缩记录 · 1 次 · 最近 18:49',
  )
})
