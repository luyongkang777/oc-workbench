// 「只接免费模型」的过滤回归（opencode 免费池专用）。
//
// 要防住三件事：
//   1. 付费模型混进「免费」这一条 → 用户第一次发消息就 402 余额不足；
//   2. 图像 / 实时 / 决策类模型混进对话清单 → 选了也发不出普通请求；
//   3. 从「全部」切到「只免费」时，已勾选的付费模型还留在 picked 里被一起保存。
import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchModelsMessage, filterModels, isChatModel, isFreeModel } from '../src/api/providerFree.ts'
import {
  applyRemoteModels,
  EMPTY_FORM,
  formFromProvider,
  PRESETS,
  presetForm,
  presetForBaseURL,
  toSaveModels,
} from '../src/components/providerForm.ts'

/** 照抄免费池 /models 的真实形状（2026-11-20 实测）。 */
const REMOTE = [
  {
    id: 'deepseek-v4.1-flash-free',
    name: 'DeepSeek V4.1 Flash Free',
    context: 200_000,
    output: 32_000,
    free: true,
    type: 'chat',
  },
  { id: 'longcat-2.5-free', name: 'LongCat 2.5 Free', context: 1_000_000, output: 262_144, free: true, type: 'chat' },
  // 付费：勾到就是 402
  { id: 'claude-fable-5', name: 'Claude Fable 5', context: 1_000_000, output: 64_000, free: false, type: 'chat' },
  // 免费但不能对话
  { id: 'grok-imagine-image-2.0', name: 'Grok Imagine 2.0', context: 64_000, output: 0, free: true, type: 'image' },
  { id: 'gpt-live-1', name: 'GPT Live 1', context: 0, output: 0, free: true, type: 'realtime' },
  { id: 'jev-1.13-free', name: 'JEV 1.13 Free', context: 64_000, output: 0, free: true, type: 'decision' },
]

test('只有上游声明免费的才算免费', () => {
  assert.equal(isFreeModel(REMOTE[0]), true)
  assert.equal(isFreeModel(REMOTE[2]), false)
  // **没有 free 字段 ≠ 免费**：DeepSeek / Command Code 不报价格
  assert.equal(isFreeModel({ id: 'x', name: 'x', context: 0, output: 0 }), false)
  assert.equal(isFreeModel({ id: 'x', name: 'x', context: 0, output: 0, free: undefined }), false)
})

test('能对话的才算对话模型', () => {
  assert.equal(isChatModel(REMOTE[0]), true)
  assert.equal(isChatModel(REMOTE[3]), false) // image
  assert.equal(isChatModel(REMOTE[4]), false) // realtime
  assert.equal(isChatModel(REMOTE[5]), false) // decision
  // 没给 type 的按 chat 处理
  assert.equal(isChatModel({ id: 'x', name: 'x', context: 0, output: 0 }), true)
})

test('过滤只留免费且能对话的', () => {
  const list = filterModels(REMOTE, 'free')
  assert.deepEqual(list.map((model) => model.id), ['deepseek-v4.1-flash-free', 'longcat-2.5-free'])
  // 空串 = 全部，一条都不裁（付费 provider 走这条）
  assert.equal(filterModels(REMOTE, '').length, REMOTE.length)
})

test('拉模型后免费预设不会把付费/图像模型放进清单和勾选', () => {
  const free = PRESETS.find((item) => item.id === 'opencode-free')
  assert.ok(free, '缺 opencode-free 预设')
  const form = presetForm(free)
  assert.equal(form.filter, 'free')

  const next = applyRemoteModels(form, REMOTE)
  assert.deepEqual(next.models.map((model) => model.id), ['deepseek-v4.1-flash-free', 'longcat-2.5-free'])
  // 首次拉取默认全选，且只全选留下来的
  assert.deepEqual(next.picked, ['deepseek-v4.1-flash-free', 'longcat-2.5-free'])
})

test('从全部切到只免费时，已勾选的付费模型要被踢出 picked', () => {
  const base = { ...EMPTY_FORM, id: 'opencode-free', filter: 'free' }
  // 模拟「先按全部勾过付费模型」的旧状态
  const dirty = {
    ...base,
    models: REMOTE,
    picked: REMOTE.map((model) => model.id),
  }
  const next = applyRemoteModels(dirty, REMOTE)
  assert.deepEqual(next.picked, ['deepseek-v4.1-flash-free', 'longcat-2.5-free'])
  // 付费模型不能留在清单里（否则保存时会被 toSaveModels 一起写进去）
  assert.ok(!next.models.some((model) => model.id === 'claude-fable-5'))
})

test('免费池与 Go 套餐是同一 host 的两个地址，图标必须分得开', () => {
  const free = presetForBaseURL('https://opencode.ai/inference/openai/v1')
  const go = presetForBaseURL('https://opencode.ai/inference/go/openai/v1')
  assert.equal(free?.id, 'opencode-free')
  assert.equal(go?.id, 'opencode-zen')
  // 按量付费网关也算 Go 那一条（同一 host，路径不同但都是付费通道）
  assert.equal(presetForBaseURL('https://opencode.ai/zen/v1')?.id, 'opencode-zen')
})

test('拉模型后的提示文案：过滤、全空、不过滤三种说法分开', () => {
  // 不过滤的付费 provider：直接报数字
  assert.equal(fetchModelsMessage(12, 12, ''), '拉到 12 个模型')
  // 正常过滤：说清「给了多少、留了多少」，否则 91→11 看着像勾选丢了
  assert.match(fetchModelsMessage(91, 11, 'free'), /上游返回 91 个，只保留 11 个/)
  // 一个都没剩：要给下一步怎么走，不能只说 0
  const empty = fetchModelsMessage(91, 0, 'free')
  assert.match(empty, /没识别出免费模型/)
  assert.match(empty, /手动勾选/)
  assert.equal(fetchModelsMessage(0, 0, 'free'), '上游没有返回任何模型')
})

test('上游没带 free 标记时不能把已配模型清空（会连带删光配置）', () => {
  // 真实风险：上游某次没带 free / cost（接口变更、走镜像），过滤后剩 0 个。
  // 如果照过滤结果写回，表单就剩 0 个模型，用户点保存 → 配置里的 models 被整段删光。
  const fromDisk = formFromProvider({
    id: 'opencode-free',
    name: 'OpenCode 免费模型',
    baseURL: 'https://opencode.ai/inference/openai/v1',
    keyMasked: '******',
    models: [
      { id: 'big-pickle', name: 'Big Pickle (OpenCode 免费模型)', context: 200000, output: 32000 },
      { id: 'iceman-free', name: 'Iceman Free (OpenCode 免费模型)', context: 262144, output: 131072 },
    ],
  })

  // 上游回了这两个，但一个 free 标记都没有
  const noFlag = applyRemoteModels(fromDisk, [
    { id: 'big-pickle', name: 'Big Pickle', context: 200000, output: 32000 },
    { id: 'iceman-free', name: 'Iceman Free', context: 262144, output: 131072 },
  ])
  assert.equal(noFlag.models.length, 2, '上游没标记时不能清空清单')
  assert.deepEqual(noFlag.picked, ['big-pickle', 'iceman-free'])
  assert.equal(toSaveModels(noFlag, 'OpenCode 免费模型').length, 2, '保存不能变成 0 个模型')

  // 上游直接回空清单（接口抽风）也一样
  const empty = applyRemoteModels(fromDisk, [])
  assert.equal(empty.models.length, 2)
  assert.equal(toSaveModels(empty, 'OpenCode 免费模型').length, 2)
})

test('上游改名后界面要跟着更新（配置里的名字是自动拼的，不是用户改的）', () => {
  const first = applyRemoteModels({ ...EMPTY_FORM, filter: '' }, [
    { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', context: 200000, output: 32000 },
  ])
  const renamed = applyRemoteModels(first, [
    { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free 2', context: 200000, output: 32000 },
  ])
  assert.equal(renamed.models[0].name, 'DeepSeek V4.1 Flash Free 2', '上游改名要跟着变')
  // 上游没给 name 时才退回旧名
  const noName = applyRemoteModels(renamed, [
    { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free 2', context: 200000, output: 32000 },
  ])
  assert.equal(noName.models[0].name, 'DeepSeek V4.1 Flash Free 2')
})
