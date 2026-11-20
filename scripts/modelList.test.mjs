// 模型下拉「隐藏内置自带模型」的回归。
//
// 要防住三件事：
//   1. 内置 provider 自带的模型还出现在下拉里（用户分不清该点哪个）；
//   2. 用户自己配的模型被误藏（把 opencode-free 当成"内置"藏掉就白屏了）；
//   3. 当前正在用的那条被藏掉 → 切走之后再也点不回来。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterByKeyword,
  isSelectable,
  selectableModels,
} from '../src/components/modelList.ts'

/** 照抄这台机器的真实形状（2026-11-21 实测 /api/model）。 */
const MODELS = [
  // 内置 provider 自带的（integrationID=opencode）
  { id: 'tidepool-alpha-free', providerID: 'opencode', name: 'Tidepool Alpha Free', builtin: true },
  { id: 'hy4-flash-free', providerID: 'opencode', name: 'Hy4 flash Free', builtin: true },
  { id: 'iceman-free', providerID: 'opencode', name: 'Iceman Free', builtin: true },
  // 用户自己配的（没有 integrationID）
  { id: 'deepseek-v4.1-flash-free', providerID: 'opencode-free', name: 'DeepSeek V4.1 Flash Free (OpenCode 免费模型)' },
  { id: 'longcat-2.5-free', providerID: 'opencode-free', name: 'LongCat 2.5 Free (OpenCode 免费模型)' },
  { id: 'deepseek-flash', providerID: 'deepseek-official', name: 'DeepSeek V4 Flash (DeepSeek 官方)' },
]

test('内置 provider 自带的模型不出现在下拉里', () => {
  const list = selectableModels(MODELS)
  assert.equal(list.length, 3, '只剩自配的 3 个')
  assert.ok(!list.some((m) => m.providerID === 'opencode'), '不该有内置 opencode 的模型')
  // 自配的全部都在
  assert.deepEqual(
    list.map((m) => m.id),
    ['deepseek-v4.1-flash-free', 'longcat-2.5-free', 'deepseek-flash'],
  )
})

test('自配的不会被误藏（哪怕 id 长得像内置的）', () => {
  // opencode-free 的 id 里带 opencode，但它没有 builtin 标记，必须显示
  const list = selectableModels(MODELS)
  assert.ok(list.some((m) => m.providerID === 'opencode-free'), 'opencode-free 必须显示')
  // 没有 builtin 字段的（老数据 / 拿不到 provider 列表）一律显示
  assert.equal(isSelectable({ id: 'x', providerID: 'opencode' }), true)
  assert.equal(isSelectable({ id: 'x', providerID: 'opencode', builtin: false }), true)
})

test('当前正在用的那条即使来自内置也要留着', () => {
  const current = { id: 'iceman-free', providerID: 'opencode' }
  const list = selectableModels(MODELS, current)
  assert.ok(
    list.some((m) => m.id === 'iceman-free' && m.providerID === 'opencode'),
    '当前选中的内置模型必须留在列表里，否则切走就点不回来',
  )
  // 其它内置的仍然藏掉
  assert.ok(!list.some((m) => m.id === 'tidepool-alpha-free'))
  assert.equal(list.length, 4)
})

test('当前选的是自配模型时，不会顺带把内置的放出来', () => {
  const list = selectableModels(MODELS, { id: 'deepseek-flash', providerID: 'deepseek-official' })
  assert.ok(!list.some((m) => m.providerID === 'opencode'))
  assert.equal(list.length, 3)
})

test('拿不到内置标记时一个都不藏（失败宁可多显示）', () => {
  // listBuiltinProviderIDs 失败会返回空集合，模型就都没有 builtin 标记
  const noFlag = MODELS.map(({ builtin, ...rest }) => rest)
  assert.equal(selectableModels(noFlag).length, MODELS.length)
})

test('关键词筛选：名称 / id / providerID 都参与匹配', () => {
  const selectable = selectableModels(MODELS)
  assert.equal(filterByKeyword(selectable, 'deepseek').length, 2)
  assert.equal(filterByKeyword(selectable, 'longcat').length, 1)
  assert.equal(filterByKeyword(selectable, 'opencode-free').length, 2)
  // 空关键词返回全部
  assert.equal(filterByKeyword(selectable, '').length, 3)
  assert.equal(filterByKeyword(selectable, '   ').length, 3)
  // 筛不到就空
  assert.equal(filterByKeyword(selectable, 'nonexistent-model').length, 0)
})

test('筛选不会把内置的"筛出来"（先隐藏再筛选）', () => {
  // 直接筛 'opencode' 关键字，内置那三条不能被筛回来
  const selectable = selectableModels(MODELS)
  const hit = filterByKeyword(selectable, 'opencode')
  assert.ok(!hit.some((m) => m.providerID === 'opencode'), '内置的不该被关键词筛回来')
})
