import {
  DEEPSEEK_BASE_URL,
  mergeModelIds,
  modelDisplayName,
  prettyModelName,
  validateDraft,
  type ModelOption,
  type ProviderDraft,
} from '../api/providerFormat.ts'

/**
 * provider 表单的状态与判定（纯函数）。
 *
 * 2026-11-16 起每个模型带 `context` / `output` 两个上限：
 *   * 上游 \`/models\` 给了就用上游的（Command Code 的 \`context_length\`、
 *     zen 的 \`limit.context\`、DeepSeek 的 \`context_window\`）；
 *   * 用户可以改，改完保存会写进 \`opencode.json\` 的 \`models.<id>.limit\`；
 *   * 没给的才退回保守默认值（128k / 8k）——**不要把 1M 的模型写成 128k**。
 */

export type FormState = {
  /** 正在编辑的 provider id；空字符串表示新增 */
  id: string
  name: string
  baseURL: string
  apiKey: string
  /** 界面上可见的模型（远端拉到的 ∪ 配置里已有的） */
  models: ModelOption[]
  /** 已勾选的模型 id */
  picked: string[]
}

export const EMPTY_FORM: FormState = {
  id: '',
  name: '',
  baseURL: '',
  apiKey: '',
  models: [],
  picked: [],
}

/** 上游没给上限时的保守默认值。 */
export const DEFAULT_CONTEXT = 128_000
export const DEFAULT_OUTPUT = 8_192

/** Magpie 网关地址：本机固定端口，OpenAI 兼容层挂在 `/v1` 下。 */
export const MAGPIE_BASE_URL = 'http://127.0.0.1:3425/v1'

export type ProviderPreset = {
  id: string
  name: string
  baseURL: string
  icon: 'deepseek' | 'opencode' | 'commandcode' | 'magpie' | 'workbuddy'
  /**
   * 预设自带的默认 key。
   *
   * 本地网关（Magpie）没有鉴权，Bearer 带什么都能过；但表单校验要求 key 非空，
   * 预设直接填好，省得用户对着「请填 API Key」发呆。
   */
  apiKey?: string
}

/**
 * ID 必须避开 opencode 内置的 provider 名（deepseek / opencode / opencode-go / commandcode…）。
 *
 * 用内置 ID 时 opencode 会把它自己那份模型目录合并进来（实测 `opencode` 写 12 个模型会显示 89 个，
 * `whitelist`/`blacklist` 都不生效），于是「没勾选的模型也会出现在下拉里」。
 * 换成自定义 ID 后，配置里写几个就是几个（实测写 3 个 = 显示 3 个）。
 */
/**
 * WorkBuddy 的本地转发端点。
 *
 * baseURL 留空是有意的：exe 的端口是随机的，远程入口还多一层 `/u/<id>/` 前缀，
 * 只能由界面按当前 origin 现拼。这个常量只用来给 provider 列表配图标与 id。
 */
export const WORKBUDDY_PRESET: ProviderPreset = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  baseURL: '',
  icon: 'workbuddy',
}

export const PRESETS: ProviderPreset[] = [
  { id: 'deepseek-official', name: 'DeepSeek 官方', baseURL: DEEPSEEK_BASE_URL, icon: 'deepseek' },
  { id: 'opencode-zen', name: 'OpenCode Go', baseURL: 'https://opencode.ai/zen/v1', icon: 'opencode' },
  {
    id: 'command-code',
    name: 'Command Code',
    baseURL: 'https://api.commandcode.ai/provider/v1',
    icon: 'commandcode',
  },
  // Magpie 是本地网关：WorkBuddy（要在 Magpie 里浏览器登录）、ZCode、Cursor 等都从这里出。
  // id 不带后缀，opencode 里的模型 id 才短（`magpie/workbuddy/deepseek-v4.1-flash`）。
  {
    id: 'magpie',
    name: 'Magpie 网关',
    baseURL: MAGPIE_BASE_URL,
    icon: 'magpie',
    apiKey: 'magpie',
  },
]

/** 预设 → 空表单（只填 id/名称/地址）。 */
export function presetForm(preset: ProviderPreset): FormState {
  return {
    id: preset.id,
    name: preset.name,
    baseURL: preset.baseURL,
    apiKey: preset.apiKey ?? '',
    models: [],
    picked: [],
  }
}

/** DeepSeek 官方预设（保留旧名字）。 */
export function deepseekPreset(): FormState {
  return presetForm(PRESETS[0])
}

/** 配置里的一条模型（status 接口回来的形状）。 */
export type ProviderModelLike = {
  id: string
  name?: string
  context?: number
  output?: number
}

/** 从配置里读出来的一条 provider → 表单（key 填掩码，用户不动就沿用磁盘上的真 key）。 */
export type ProviderLike = {
  id: string
  name: string
  baseURL: string
  keyMasked: string
  models: ProviderModelLike[]
}

export function formFromProvider(info: ProviderLike): FormState {
  return {
    id: info.id,
    name: info.name,
    baseURL: info.baseURL,
    apiKey: info.keyMasked,
    models: info.models.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      context: model.context || 0,
      output: model.output || 0,
    })),
    picked: info.models.map((model) => model.id),
  }
}

/** 表单 → 草稿（只取校验要用的四个字段）。 */
export function toDraft(form: FormState): ProviderDraft {
  return {
    id: form.id,
    name: form.name,
    baseURL: form.baseURL,
    apiKey: form.apiKey,
  }
}

/** 能不能点「获取模型」：至少得有地址和 key（掩码也算有）。 */
export function canFetchModels(form: FormState): boolean {
  return Boolean(form.baseURL.trim() && form.apiKey.trim())
}

/** 能不能点「保存」：草稿合法 + 至少勾一个模型。 */
export function canSave(form: FormState): boolean {
  return validateDraft(toDraft(form)).ok && form.picked.length > 0
}

/** 保存前的错误提示（不可保存时返回原因，可保存返回 null）。 */
export function saveBlockReason(form: FormState): string | null {
  const check = validateDraft(toDraft(form))
  if (!check.ok) return check.error
  if (form.picked.length === 0) return '至少勾选一个模型（先点「获取模型」）'
  return null
}

/**
 * 界面上要显示的模型清单。
 *
 * 现在直接用 `form.models`（远端与配置已经合并进来了）；保留这个函数名，
 * 只是把「取哪些」的规则集中一处。
 */
export function visibleModels(form: FormState): string[] {
  return form.models.map((model) => model.id)
}

/** 勾选/取消勾选。 */
export function togglePicked(form: FormState, modelId: string): FormState {
  const id = modelId.trim()
  if (!id) return form
  const has = form.picked.includes(id)
  return {
    ...form,
    picked: has ? form.picked.filter((item) => item !== id) : [...form.picked, id],
  }
}

/**
 * 全选 / 全不选。
 *
 * 范围是「界面上能看到的模型」（远端 ∪ 已勾选），否则手填的模型会在全选后反而被踢掉。
 */
export function setPickedAll(form: FormState, checked: boolean): FormState {
  return { ...form, picked: checked ? visibleModels(form) : [] }
}

/**
 * 改某个模型的上下文/输出上限。
 *
 * 空值或非数字按 0 处理（保存时不写 limit），负数和超大值夹到合理范围。
 */
export function updateModelLimit(
  form: FormState,
  modelId: string,
  field: 'context' | 'output',
  raw: string,
): FormState {
  const value = Number.parseInt(raw.replace(/[^\d]/g, ''), 10)
  const safe = Number.isFinite(value) && value > 0 ? Math.min(value, 100_000_000) : 0
  return {
    ...form,
    models: form.models.map((model) =>
      model.id === modelId ? { ...model, [field]: safe } : model,
    ),
  }
}

/** 一条模型的最终上下文：上游/用户给的优先，没有才回默认值。 */
export function effectiveContext(model: ModelOption): number {
  return model.context > 0 ? model.context : DEFAULT_CONTEXT
}

/**
 * 一条模型的最终输出上限。
 *
 * **0 表示「上游没给，别瞎写」**：opencode 不写 `limit.output` 时会用模型自己的上限；
 * 以前这里回落到 8192，等于把 Claude 这类 64k 输出的模型截断到 8k。
 */
export function effectiveOutput(model: ModelOption): number {
  return model.output > 0 ? model.output : 0
}

/**
 * 拉取成功后应用结果。
 *
 * 规则：
 *   * 已有模型保留「名字」（用户可能改过），但**上下文/输出以本次上游为准**——
 *     这正是「1M 的模型别显示成 128k」要修的事；
 *   * 新模型直接用上游给的元数据；
 *   * 首次拉取且还没勾选时默认全选。
 */
export function applyRemoteModels(form: FormState, remote: ModelOption[]): FormState {
  const byId = new Map(form.models.map((model) => [model.id, model]))
  for (const item of remote) {
    const existing = byId.get(item.id)
    byId.set(item.id, {
      id: item.id,
      name: existing?.name && existing.name !== existing.id ? existing.name : item.name || prettyModelName(item.id),
      context: item.context || existing?.context || 0,
      output: item.output || existing?.output || 0,
    })
  }
  const merged = mergeModelIds(remote.map((item) => item.id), form.models.map((item) => item.id))
  const models = merged
    .map((id) => byId.get(id))
    .filter((item): item is ModelOption => Boolean(item))
  return {
    ...form,
    models,
    picked: form.picked.length > 0 ? form.picked : merged,
  }
}

/**
 * 保存时提交的模型清单：只取勾选的，名字统一成「模型名 (商家名)」。
 */
export function toSaveModels(
  form: FormState,
  providerName: string,
): Array<{ id: string; name: string; context: number; output: number }> {
  const name = providerName.trim() || form.name.trim() || form.id.trim()
  return form.models
    .filter((model) => form.picked.includes(model.id))
    .map((model) => ({
      id: model.id,
      // 上游给的 name 已经像人话就沿用它，否则按 id 拆
      name: modelDisplayName(model.name || model.id, name),
      context: effectiveContext(model),
      output: effectiveOutput(model),
    }))
}

/** 按 baseURL 的 host 找预设，用来给列表里的条目配图标。 */
export function presetForBaseURL(raw: string): ProviderPreset | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  let host = ''
  let pathname = ''
  try {
    const url = new URL(text.includes('://') ? text : `https://${text}`)
    // 用 host（含端口）而不是 hostname：本机网关靠端口区分（127.0.0.1:3425）
    host = url.host.toLowerCase()
    pathname = url.pathname
  } catch {
    return null
  }
  // WorkBuddy 的本地转发：端口随机，只能靠路径认
  if (pathname.includes('/local/workbuddy/v1')) return WORKBUDDY_PRESET
  const known: Record<string, string> = {
    'api.deepseek.com': 'deepseek-official',
    'deepseek.com': 'deepseek-official',
    'opencode.ai': 'opencode-zen',
    'api.commandcode.ai': 'command-code',
    'commandcode.ai': 'command-code',
    '127.0.0.1:3425': 'magpie',
    'localhost:3425': 'magpie',
  }
  const id = known[host]
  return PRESETS.find((preset) => preset.id === id) ?? null
}
