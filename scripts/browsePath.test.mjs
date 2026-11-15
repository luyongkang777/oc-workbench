// 目录选择面板的纯函数回归：面包屑拆解。
// node --experimental-strip-types --test scripts/browsePath.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { breadcrumbs } from '../src/api/browse.ts'

test('盘符 + 多级目录拆成可点的面包屑', () => {
  assert.deepEqual(breadcrumbs('C:\\Users\\a1890'), [
    { label: 'C:', path: 'C:\\' },
    { label: 'Users', path: 'C:\\Users' },
    { label: 'a1890', path: 'C:\\Users\\a1890' },
  ])
})

test('盘符根只有一段，路径带反斜杠', () => {
  assert.deepEqual(breadcrumbs('D:\\'), [{ label: 'D:', path: 'D:\\' }])
})

test('正斜杠与尾斜杠都能处理', () => {
  assert.deepEqual(breadcrumbs('F:/opencode/workbench/'), [
    { label: 'F:', path: 'F:\\' },
    { label: 'opencode', path: 'F:\\opencode' },
    { label: 'workbench', path: 'F:\\opencode\\workbench' },
  ])
})

test('空路径返回空数组（盘符列表那一层）', () => {
  assert.deepEqual(breadcrumbs(''), [])
  assert.deepEqual(breadcrumbs('   '), [{ label: '   ', path: '   ' }].slice(0, 0))
})

test('中文目录名原样保留', () => {
  assert.deepEqual(breadcrumbs('F:\\学习课程\\驱动内核'), [
    { label: 'F:', path: 'F:\\' },
    { label: '学习课程', path: 'F:\\学习课程' },
    { label: '驱动内核', path: 'F:\\学习课程\\驱动内核' },
  ])
})
