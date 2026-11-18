// 「只能看当前目录」的回归测试：node --experimental-strip-types --test scripts/locateFile.test.mjs
//
// 真实故障：状态栏/工具详情里给的是 `.tmp/patch-verify-4.mjs`，文件不在当前工作区，
// 查看区直接按当前根拼路径 → 404 文件不存在，只有一个「重试」，重试还是 404。
// 修法是按「当前 → 上级目录 → 其它项目」三级作用域依次找。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  baseNameOf,
  dirNameOf,
  isAbsPath,
  joinRoot,
  locateFile,
  normalizeRel,
  parentOf,
  scopeRoots,
  similarKey,
} from '../src/components/locateFile.ts'

test('盘符根没有上一级，不能把整块盘当搜索范围', () => {
  assert.equal(parentOf('F:\\opencode\\workbench'), 'F:\\opencode')
  assert.equal(parentOf('F:\\opencode'), null)
  assert.equal(parentOf('F:'), null)
  assert.equal(parentOf('F:\\'), null)
  assert.equal(parentOf(''), null)
})

test('作用域顺序：当前 → 上级 → 其它项目，且按大小写/斜杠去重', () => {
  const roots = scopeRoots('F:\\opencode\\workbench', [
    'F:\\opencode\\workbench\\',
    'f:/OPENCODE/workbench',
    'F:\\other',
    '',
  ])
  assert.deepEqual(roots, ['F:\\opencode\\workbench', 'F:\\opencode', 'F:\\other'])
})

test('相对路径归一、绝对路径拼接、目录/文件名拆分', () => {
  assert.equal(normalizeRel('.tmp/a.mjs'), '.tmp\\a.mjs')
  assert.equal(normalizeRel('/.tmp//a.mjs'), '.tmp\\a.mjs')
  assert.equal(joinRoot('F:\\opencode', '.tmp/a.mjs'), 'F:\\opencode\\.tmp\\a.mjs')
  assert.equal(joinRoot('F:\\opencode\\', '\\a.mjs'), 'F:\\opencode\\a.mjs')
  assert.equal(baseNameOf('F:\\a\\b.mjs'), 'b.mjs')
  assert.equal(baseNameOf('.tmp/patch-verify-4.mjs'), 'patch-verify-4.mjs')
  assert.equal(dirNameOf('.tmp/patch-verify-4.mjs'), '.tmp')
  assert.equal(dirNameOf('a.mjs'), '')
  assert.equal(dirNameOf('a\\b\\c.mjs'), 'a\\b')
})

test('绝对路径判定', () => {
  assert.equal(isAbsPath('F:\\a\\b.mjs'), true)
  assert.equal(isAbsPath('f:/a/b.mjs'), true)
  assert.equal(isAbsPath('\\\\host\\share\\a.mjs'), true)
  assert.equal(isAbsPath('.tmp/a.mjs'), false)
})

test('相似名键：同族序号文件能互相匹配', () => {
  assert.equal(similarKey('patch-verify-4.mjs'), 'patch-verify-|.mjs')
  assert.equal(similarKey('patch-verify-12.mjs'), 'patch-verify-|.mjs')
  // 扩展名不同不算同族（.mjs 与 .log 多半是无关产物）
  assert.equal(similarKey('patch-verify-9.log'), 'patch-verify-|.log')
  // 没有数字的文件名不参与相似匹配（只认完全同名）
  assert.equal(similarKey('README.md'), null)
  // 前缀太短（只有序号）时相似没有意义
  assert.equal(similarKey('4.mjs'), null)
})

/** 假 IO：只认给定的「绝对路径 → 存在」集合，find/list 按预置表返回。 */
function fakeIo({ exists = [], files = {}, dirs = {} } = {}) {
  const calls = []
  const found = new Set(exists.map((p) => p.toLowerCase()))
  return {
    calls,
    stat: async (root, rel) => {
      calls.push(['stat', root, rel])
      if (found.has(joinRoot(root, rel).toLowerCase())) return { size: 1 }
      throw new Error('404 文件不存在：' + rel)
    },
    find: async (root, name) => {
      calls.push(['find', root, name])
      return (files[root]?.[name] ?? []).map((p) => ({ path: p, type: 'file' }))
    },
    list: async (root, dir) => {
      calls.push(['list', root, dir])
      const entries = dirs[`${root}\u0000${dir}`]
      if (!entries) throw new Error('404 文件不存在：' + dir)
      return entries.map((p) => ({ path: p, type: 'file' }))
    },
  }
}

test('精确相对路径命中：当前工作区里就有，不该再往上扫', async () => {
  const io = fakeIo({ exists: ['F:\\opencode\\workbench\\a.mjs'] })
  const hits = await locateFile('a.mjs', { root: 'F:\\opencode\\workbench' }, io)
  assert.deepEqual(hits, [
    {
      abs: 'F:\\opencode\\workbench\\a.mjs',
      root: 'F:\\opencode\\workbench',
      path: 'a.mjs',
      how: 'exact',
    },
  ])
  assert.equal(io.calls.some(([kind]) => kind !== 'stat'), false)
})

test('当前工作区没有 → 退到上级目录按原相对路径找到', async () => {
  const io = fakeIo({ exists: ['F:\\opencode\\.tmp\\patch-verify-4.mjs'] })
  const hits = await locateFile('.tmp/patch-verify-4.mjs', { root: 'F:\\opencode\\workbench' }, io)
  assert.deepEqual(hits, [
    {
      abs: 'F:\\opencode\\.tmp\\patch-verify-4.mjs',
      root: 'F:\\opencode',
      path: '.tmp\\patch-verify-4.mjs',
      how: 'exact',
    },
  ])
})

test('精确路径全落空 → 按文件名在其它项目里找到', async () => {
  const io = fakeIo({
    files: { 'F:\\other': { 'patch-verify-4.mjs': ['lib\\patch-verify-4.mjs'] } },
  })
  const hits = await locateFile(
    '.tmp/patch-verify-4.mjs',
    { root: 'F:\\opencode\\workbench', projects: ['F:\\other'] },
    io,
  )
  assert.deepEqual(hits, [
    {
      abs: 'F:\\other\\lib\\patch-verify-4.mjs',
      root: 'F:\\other',
      path: 'lib\\patch-verify-4.mjs',
      how: 'basename',
    },
  ])
})

test('同名也找不到 → 在原目录里给出同族序号文件（patch-verify-1/3）', async () => {
  const io = fakeIo({
    dirs: {
      'F:\\opencode\\workbench\u0000.tmp': [
        '.tmp\\patch-verify-1.mjs',
        '.tmp\\patch-verify-3.mjs',
        '.tmp\\other.mjs',
        '.tmp\\patch-verify-9.log',
      ],
    },
  })
  const hits = await locateFile('.tmp/patch-verify-4.mjs', { root: 'F:\\opencode\\workbench' }, io)
  assert.deepEqual(
    hits.map((hit) => hit.path),
    ['.tmp\\patch-verify-1.mjs', '.tmp\\patch-verify-3.mjs'],
  )
  assert.equal(hits[0].how, 'similar')
  // 第 3 级只 list 目录，绝不再发全树搜索
  assert.equal(io.calls.some(([kind]) => kind === 'mentions'), false)
})

test('第一级命中后不再发 find / list（别为已找到的继续烧查询）', async () => {
  const io = fakeIo({ exists: ['F:\\opencode\\workbench\\.tmp\\a.mjs'] })
  await locateFile('.tmp/a.mjs', { root: 'F:\\opencode\\workbench' }, io)
  assert.deepEqual(
    io.calls.map(([kind]) => kind),
    ['stat'],
  )
})

test('绝对路径只查它自己，不按同名去别处乱找', async () => {
  const io = fakeIo({ exists: ['D:\\proj\\a.mjs'] })
  const hits = await locateFile('D:\\proj\\a.mjs', { root: 'F:\\opencode\\workbench' }, io)
  assert.deepEqual(hits, [
    { abs: 'D:\\proj\\a.mjs', root: 'D:\\proj', path: 'a.mjs', how: 'exact' },
  ])
  assert.equal(io.calls.some(([, root]) => root === 'F:\\opencode\\workbench'), false)
})

test('哪里都没有 → 空结果，不抛错', async () => {
  const io = fakeIo()
  const hits = await locateFile('nope.mjs', { root: 'F:\\opencode\\workbench' }, io)
  assert.deepEqual(hits, [])
})

test('空输入直接返回，不发任何请求', async () => {
  const io = fakeIo()
  assert.deepEqual(await locateFile('   ', { root: 'F:\\a' }, io), [])
  assert.deepEqual(io.calls, [])
})
