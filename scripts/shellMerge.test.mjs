import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ITEMS, mergeSeen } from '../src/components/shellMerge.ts'

/** 造一条最小可用的 ShellInfo。 */
function shell(id, status, started = 0) {
  return {
    id,
    status,
    command: `echo ${id}`,
    cwd: 'F:\\x',
    shell: 'pwsh.exe',
    file: 'C:\\out.txt',
    pid: 100,
    metadata: {},
    time: { started },
  }
}

test('mergeSeen: 本地终态不被服务端返回的 running 盖回去', () => {
  const seen = new Map()
  seen.set('a', shell('a', 'killed', 1))
  const kept = mergeSeen(seen, [shell('a', 'running', 1)])
  assert.equal(kept.length, 1)
  assert.equal(kept[0].status, 'killed')
})

test('mergeSeen: 新条目会并入缓存', () => {
  const seen = new Map()
  mergeSeen(seen, [shell('a', 'running', 5)])
  const kept = mergeSeen(seen, [shell('b', 'running', 9)])
  assert.deepEqual(kept.map((item) => item.id), ['b', 'a'])
})

test('mergeSeen: 裁剪时优先保留运行中的条目', () => {
  const seen = new Map()
  for (let i = 0; i < MAX_ITEMS; i += 1) {
    // 全部是更早的已退出条目
    seen.set(`old-${i}`, shell(`old-${i}`, 'exited', i))
  }
  const kept = mergeSeen(seen, [shell('running-new', 'running', 1)])
  assert.ok(kept.some((item) => item.id === 'running-new'))
  assert.equal(kept.length, MAX_ITEMS)
  assert.equal(kept[0].id, 'running-new')
})

test('mergeSeen: 被裁掉的条目会同时从缓存删除（不会无限增长）', () => {
  const seen = new Map()
  for (let i = 0; i < MAX_ITEMS + 5; i += 1) {
    seen.set(`x-${i}`, shell(`x-${i}`, 'exited', i))
  }
  const kept = mergeSeen(seen, [])
  assert.equal(kept.length, MAX_ITEMS)
  assert.equal(seen.size, MAX_ITEMS)
})

test('mergeSeen: 服务端返回的新终态会更新本地正在跑的条目', () => {
  const seen = new Map()
  seen.set('a', shell('a', 'running', 1))
  const kept = mergeSeen(seen, [shell('a', 'exited', 1)])
  assert.equal(kept[0].status, 'exited')
})
