// 项目清单的回归测试：node --experimental-strip-types --test scripts/projectList.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findProject,
  normKey,
  parseProjects,
  projectNameOf,
  removeProject,
  setProjectState,
  sortProjects,
  touchProject,
  upsertProject,
} from '../src/components/projectList.ts'

test('路径规范化：尾分隔符、正反斜杠、大小写都不影响比较', () => {
  assert.equal(normKey('F:\\opencode\\'), 'f:/opencode')
  assert.equal(normKey('"F:/opencode"'), 'f:/opencode')
  assert.equal(normKey('f:\\Opencode'), normKey('F:/opencode/'))
  assert.equal(normKey(''), '')
})

test('项目名取最后一段', () => {
  assert.equal(projectNameOf('F:\\opencode'), 'opencode')
  assert.equal(projectNameOf('F:\\健身\\MerachRun\\'), 'MerachRun')
  assert.equal(projectNameOf('/home/me/api'), 'api')
  assert.equal(projectNameOf('F:\\'), 'F:')
})

test('坏数据不让整份清单失效', () => {
  const list = parseProjects([
    { path: 'F:\\a', name: 'a' },
    null,
    'nope',
    { name: '没有路径' },
    { path: '  ' },
    { path: 'F:\\b' },
  ])
  assert.deepEqual(
    list.map((p) => p.path),
    ['F:\\a', 'F:\\b'],
  )
  // 没给名字就用目录名
  assert.equal(list[1].name, 'b')
})

test('同一路径只留一条（大小写/斜杠不同也算同一条）', () => {
  const list = upsertProject(upsertProject([], 'F:\\opencode'), 'f:/opencode/')
  assert.equal(list.length, 1)
})

test('重复加入不会丢掉已经记住的状态', () => {
  const first = upsertProject([], 'F:\\a')
  const withState = setProjectState(first, 'F:\\a', { file: 'src/x.ts', view: 'diff' })
  const again = upsertProject(withState, 'F:\\a', { lastUsed: Date.now() })

  const hit = findProject(again, 'F:\\a')
  assert.equal(hit.state.file, 'src/x.ts')
  assert.equal(hit.state.view, 'diff')
})

test('按最近使用排序，新用的排最前', () => {
  let list = upsertProject([], 'F:\\a', { lastUsed: 1 })
  list = upsertProject(list, 'F:\\b', { lastUsed: 2 })
  assert.deepEqual(
    list.map((p) => p.name),
    ['b', 'a'],
  )
  list = touchProject(list, 'F:\\a')
  assert.equal(list[0].name, 'a')
})

test('时间相同时保持原顺序（排序稳定）', () => {
  const list = sortProjects([
    { path: 'F:\\a', name: 'a', lastUsed: 5 },
    { path: 'F:\\b', name: 'b', lastUsed: 5 },
  ])
  assert.deepEqual(
    list.map((p) => p.name),
    ['a', 'b'],
  )
})

test('移除按路径匹配，删不掉不存在的条目', () => {
  const list = upsertProject(upsertProject([], 'F:\\a'), 'F:\\b')
  assert.equal(removeProject(list, 'f:/a/').length, 1)
  assert.equal(removeProject(list, 'F:\\nope').length, 2)
})

test('给不存在的项目记状态不会凭空造出一条', () => {
  const list = upsertProject([], 'F:\\a')
  const next = setProjectState(list, 'F:\\other', { file: 'x.ts' })
  assert.equal(next.length, 1)
  assert.equal(next[0].state, undefined)
})

test('清单有上限，不会无限膨胀', () => {
  let list = []
  for (let i = 0; i < 60; i++) list = upsertProject(list, `F:\\p${i}`, { lastUsed: i })
  assert.equal(list.length, 40)
  // 留下的是最近用过的
  assert.equal(list[0].name, 'p59')
})
