// provider 表单状态机回归（模型带上下文/上限版）。
//
// 重点验三件事：
//   1. 上下文/输出以「上游给的」为准——1M 的模型不能存成 128k；
//   2. 模型名要带商家名（"DeepSeek V4.1 Flash (OpenCode Go)"）；
//   3. 全选 / 取消全选 / 勾选这些按钮判定不卡死。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyRemoteModels,
  canFetchModels,
  canSave,
  DEFAULT_CONTEXT,
  DEFAULT_OUTPUT,
  deepseekPreset,
  effectiveContext,
  effectiveOutput,
  EMPTY_FORM,
  formFromProvider,
  PRESETS,
  presetForBaseURL,
  presetForm,
  saveBlockReason,
  setPickedAll,
  toDraft,
  toSaveModels,
  togglePicked,
  updateModelLimit,
  visibleModels,
  WORKBUDDY_PRESET,
} from '../src/components/providerForm.ts'
import { normalizeBaseURL } from '../src/api/providerFormat.ts'

const FULL = {
  id: 'command-code',
  name: 'Command Code',
  baseURL: 'https://api.commandcode.ai/provider/v1',
  apiKey: 'user_1234567890abcdef',
}

const OPTIONS = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', context: 1_000_000, output: 64_000 },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', context: 128_000, output: 8_192 },
]

test('预设：三个 ID 都避开 opencode 内置名', () => {
  assert.deepEqual(PRESETS.map((item) => item.id), [
    'deepseek-official',
    'opencode-zen',
    'command-code',
    'magpie',
  ])
  const form = presetForm(PRESETS[0])
  assert.equal(form.id, 'deepseek-official')
  assert.equal(form.baseURL, 'https://api.deepseek.com/v1')
  assert.deepEqual(form.models, [])
  assert.deepEqual(deepseekPreset(), presetForm(PRESETS[0]))
  for (const preset of PRESETS) {
    assert.equal(normalizeBaseURL(preset.baseURL), preset.baseURL, preset.id)
  }
})

test('从配置读出来的 provider：模型带上下文，key 用掩码', () => {
  const form = formFromProvider({
    id: 'command-code',
    name: 'Command Code',
    baseURL: 'https://api.commandcode.ai/provider/v1',
    keyMasked: 'user…cdef',
    models: [
      { id: 'a', name: 'A (Command Code)', context: 1_000_000, output: 64_000 },
      { id: 'b', name: 'B (Command Code)', context: 0, output: 0 },
    ],
  })
  assert.equal(form.apiKey, 'user…cdef')
  assert.deepEqual(form.picked, ['a', 'b'])
  assert.equal(form.models[0].context, 1_000_000)
})

test('获取模型按钮：地址和 key 都有才可点', () => {
  assert.equal(canFetchModels(EMPTY_FORM), false)
  assert.equal(canFetchModels({ ...EMPTY_FORM, baseURL: 'https://x/v1' }), false)
  assert.equal(canFetchModels({ ...EMPTY_FORM, baseURL: 'https://x/v1', apiKey: 'k' }), true)
})

test('保存按钮：草稿合法且至少勾一个模型', () => {
  const form = { ...EMPTY_FORM, ...FULL, models: OPTIONS, picked: [] }
  assert.equal(canSave(form), false)
  assert.match(saveBlockReason(form) ?? '', /至少勾选一个模型/)
  assert.equal(canSave({ ...form, picked: ['a'] }), true)
  assert.equal(saveBlockReason({ ...form, picked: ['a'] }), null)
})

test('保存按钮：非法草稿给出具体原因', () => {
  const form = { ...EMPTY_FORM, ...FULL, models: OPTIONS, picked: ['a'] }
  assert.match(saveBlockReason({ ...form, id: '' }) ?? '', /填一个 ID/)
  assert.match(saveBlockReason({ ...form, id: 'a b' }) ?? '', /只能用字母/)
  assert.match(saveBlockReason({ ...form, baseURL: 'nope' }) ?? '', /http\(s\)/)
  assert.match(saveBlockReason({ ...form, apiKey: '' }) ?? '', /API Key/)
})

test('勾选 / 全选 / 取消全选', () => {
  let form = { ...EMPTY_FORM, models: OPTIONS, picked: ['claude-sonnet-5-5'] }
  form = togglePicked(form, 'deepseek/deepseek-v4-flash')
  assert.deepEqual(form.picked, ['claude-sonnet-5-5', 'deepseek/deepseek-v4-flash'])
  form = togglePicked(form, 'claude-sonnet-5-5')
  assert.deepEqual(form.picked, ['deepseek/deepseek-v4-flash'])
  assert.deepEqual(visibleModels(form), ['claude-sonnet-5-5', 'deepseek/deepseek-v4-flash'])
  assert.deepEqual(setPickedAll(form, true).picked, ['claude-sonnet-5-5', 'deepseek/deepseek-v4-flash'])
  assert.deepEqual(setPickedAll(form, false).picked, [])
})

test('拉取结果：上下文/输出用上游的，首次默认全选', () => {
  const form = applyRemoteModels(EMPTY_FORM, OPTIONS)
  assert.deepEqual(form.picked, ['claude-sonnet-5-5', 'deepseek/deepseek-v4-flash'])
  assert.equal(form.models[0].context, 1_000_000)
  assert.equal(form.models[0].output, 64_000)
})

test('再次拉取时会用上游上下文覆盖旧的 128k（修复上下文问题的关键）', () => {
  const stale = {
    ...EMPTY_FORM,
    models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', context: 128_000, output: 8_192 }],
    picked: ['claude-sonnet-5-5'],
  }
  const fresh = applyRemoteModels(stale, OPTIONS)
  assert.equal(fresh.models[0].context, 1_000_000, '1M 的模型不能还是 128k')
  // 用户已勾选的不能被全选覆盖
  assert.deepEqual(fresh.picked, ['claude-sonnet-5-5'])
})

test('自定义上下文：输入框改的值要能存下来', () => {
  let form = applyRemoteModels(EMPTY_FORM, OPTIONS)
  form = updateModelLimit(form, 'claude-sonnet-5-5', 'context', '2000000')
  form = updateModelLimit(form, 'claude-sonnet-5-5', 'output', '100000')
  assert.equal(form.models[0].context, 2_000_000)
  assert.equal(form.models[0].output, 100_000)
  // 非法输入回落 0（保存时不写 limit），上下文显示时用默认值
  const broken = updateModelLimit(form, 'claude-sonnet-5-5', 'context', 'abc')
  assert.equal(broken.models[0].context, 0)
  assert.equal(effectiveContext(broken.models[0]), DEFAULT_CONTEXT)
  // output 未知时保持 0（保存时不写 limit.output，避免把 64k 模型截成 8k）
  assert.equal(effectiveOutput({ id: 'x', name: 'x', context: 0, output: 0 }), 0)
})

test('保存清单：只提交勾选的，名字带商家名，带上真实上下文', () => {
  const form = { ...EMPTY_FORM, ...FULL, models: OPTIONS, picked: ['claude-sonnet-5-5'] }
  const saved = toSaveModels(form, 'Command Code')
  assert.equal(saved.length, 1)
  assert.equal(saved[0].id, 'claude-sonnet-5-5')
  assert.equal(saved[0].name, 'Claude Sonnet 5.5 (Command Code)')
  assert.equal(saved[0].context, 1_000_000)
  assert.equal(saved[0].output, 64_000)
})

test('上游没给输出上限时，保存清单里 output=0（不写死 8192）', () => {
  const form = {
    ...EMPTY_FORM,
    ...FULL,
    models: [{ id: 'm', name: 'M', context: 1_000_000, output: 0 }],
    picked: ['m'],
  }
  const saved = toSaveModels(form, 'Command Code')
  assert.equal(saved[0].output, 0)
  assert.equal(saved[0].context, 1_000_000)
})

test('保存清单：id 当名字时按 id 拆词再拼商家名', () => {
  const form = {
    ...EMPTY_FORM,
    ...FULL,
    models: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'deepseek/deepseek-v4.1-flash', context: 0, output: 0 }],
    picked: ['deepseek/deepseek-v4.1-flash'],
  }
  const saved = toSaveModels(form, 'OpenCode Go')
  assert.equal(saved[0].name, 'DeepSeek V4.1 Flash (OpenCode Go)')
  // 上游没给上下文 → 提交默认值（保证模型可用）
  assert.equal(saved[0].context, DEFAULT_CONTEXT)
})

test('按地址反查预设图标', () => {
  assert.equal(presetForBaseURL('https://api.deepseek.com/v1')?.id, 'deepseek-official')
  assert.equal(presetForBaseURL('https://opencode.ai/zen/v1')?.id, 'opencode-zen')
  assert.equal(presetForBaseURL('https://api.commandcode.ai/provider/v1')?.id, 'command-code')
  assert.equal(presetForBaseURL('http://127.0.0.1:3425/v1')?.id, 'magpie')
  // WorkBuddy 走本机转发：端口随机，靠路径认
  assert.equal(presetForBaseURL('http://127.0.0.1:54321/local/workbuddy/v1')?.id, 'workbuddy')
  assert.equal(presetForBaseURL('http://localhost:3425/v1')?.id, 'magpie')
  assert.equal(presetForBaseURL('https://my-proxy.example.com/v1'), null)
})

test('Magpie 预设：地址指向本机网关，自带非空 key', () => {
  const preset = PRESETS.find((item) => item.id === 'magpie')
  assert.ok(preset, '应该有 magpie 预设')
  const form = presetForm(preset)
  assert.equal(form.baseURL, 'http://127.0.0.1:3425/v1')
  assert.equal(form.apiKey, 'magpie')
  // 本地网关不校验 key，但「获取模型」按钮要求表单有值
  assert.equal(canFetchModels(form), true)
  // 端口不能被补成 /v1/v1
  assert.equal(normalizeBaseURL(form.baseURL), form.baseURL)
})

test('WorkBuddy 预设在界面现拼地址时仍能认出图标', () => {
  assert.equal(WORKBUDDY_PRESET.id, 'workbuddy')
  assert.equal(WORKBUDDY_PRESET.icon, 'workbuddy')
  // 地址留空是给界面按 origin 现拼的，别在预设里写死 127.0.0.1
  assert.equal(WORKBUDDY_PRESET.baseURL, '')
})

test('toDraft 只取校验需要的四个字段', () => {
  const draft = toDraft({ ...EMPTY_FORM, ...FULL, models: OPTIONS, picked: ['a'] })
  assert.deepEqual(draft, FULL)
})
