import {
  mergeModelIds,
  modelDisplayName,
  prettyModelName,
  validateDraft,
  type ModelOption,
  type ProviderDraft,
} from '../api/providerFormat.ts'
import { filterModels, type ModelFilter } from '../api/providerFree.ts'
import {
  PRESETS,
  presetById,
  presetForBaseURL,
  type ProviderPreset,
} from './providerPresetsData.ts'

/**
 * provider 表单的状态与判定（纯函数）。
 *
 * 2026-11-16 起每个模型带 `context` / `output` 两个上限：
 *   * 上游 `/models` 给了就用上游的（Command Code 的 `context_length`、
 *     zen 的 `limit.context`、DeepSeek 的 `context_window`）；
 *   * 用户可以改，改完保存会写进 `opencode.json` 的 `models.<id>.limit`；
 *   * 没给的才退回保守默认值（128k / 8k）——**不要把 1M 的模型写成 128k**。
 *
 * 预设数据、地址反查在 `providerPresetsData.ts`（这里只保留表单逻辑，避免破 300 行墙）。
 */

// 预设相关全部从这里转出：界面与单测都只 import 这个文件，
// 拆分对调用方无感。
export {
  MAGPIE_BASE_URL,
  OPENCODE_FREE_BASE_URL,
  OPENCODE_FREE_KEY,
  OPENCODE_GO_BASE_URL,
  PRESETS,
  presetById,
  presetForBaseURL,
  MAXI_PRESET,
  WORKBUDDY_PRESET,
  type ProviderPreset,
} from './providerPresetsData.ts'

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
  /** 拉模型后只留哪些（`'free'` = 只留免费对话模型；空串 = 全部） */
  filter: ModelFilter
}

export const EMPTY_FORM: FormState = {
  id: '',
  name: '',
  baseURL: '',
  apiKey: '',
  models: [],
  picked: [],
  filter: '',
}

/** 上游没给上限时的保守默认值。 */
export const DEFAULT_CONTEXT = 128_000
export const DEFAULT_OUTPUT = 8_192

/** 预设 → 空表单（只填 id / 名称 / 地址 / key / 过滤模式）。 */
export function presetForm(preset: ProviderPreset): FormState {
  return {
    id: preset.id,
    name: preset.name,
    baseURL: preset.baseURL,
    apiKey: preset.apiKey ?? '',
    models: [],
    picked: [],
    filter: preset.filter ?? '',
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
    // 重新打开免费池条目时要继续只显示免费模型——按地址认，不依赖 id 命名
    filter: presetForBaseURL(info.baseURL)?.filter ?? '',
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
  // 先按预设的过滤模式裁剪远端清单：免费池会把付费模型一起返回，
  // 不裁就会让用户在「免费」这一条里勾到要钱的模型（第一次发消息就 402）。
  const allowed = filterModels(remote, form.filter)
  // **保护：过滤后一个都没剩、但表单里本来有模型 —— 绝不能把清单清空。**
  // 触发场景都是实测过的：上游某次没带 free / 没带 cost 标记（接口变更、走了别的镜像），
  // 或返回空清单（接口抽风）。这时如果按过滤结果写回，表单就剩 0 个模型，
  // 用户接着点「保存」→ 配置里那条 provider 的 models 被整段删光，模型凭空消失。
  // 保留原样最安全：用户还能手动取消勾选，也能看到旧模型继续用。
  if (form.filter !== '' && allowed.length === 0 && form.models.length > 0) {
    return form
  }
  const byId = new Map(form.models.map((model) => [model.id, model]))
  for (const item of allowed) {
    const existing = byId.get(item.id)
    byId.set(item.id, {
      id: item.id,
      // 名字以上游为准：配置里存的名字是保存时按「模型名 (商家名)」自动拼的，
      // 不是用户的创作，所以上游改名（Flash → Flash 2）就该跟着变。
      // 以前用「旧名 != id」判断「用户改过」——保存后的名字永远带括号、条件永远成立，
      // 结果上游改名后界面一辈子显示旧名（实测确认）。
      // 上游没给 name 时才退回旧名，最后才按 id 拆词。
      name: item.name || existing?.name || prettyModelName(item.id),
      context: item.context || existing?.context || 0,
      output: item.output || existing?.output || 0,
      free: item.free,
      type: item.type,
    })
  }
  // 并集是给「远端漏报某些模型」的中转站用的；但**过滤模式下不能并旧清单**——
  // 旧清单里可能躺着付费模型（用户先按「全部」拉过一次），并进来就又混进免费这一条了。
  const merged =
    form.filter === ''
      ? mergeModelIds(allowed.map((item) => item.id), form.models.map((item) => item.id))
      : allowed.map((item) => item.id)
  const models = merged
    .map((id) => byId.get(id))
    .filter((item): item is ModelOption => Boolean(item))
  // 已勾选的模型可能被过滤掉（从「全部」切到「只免费」）：收敛一次，
  // 否则保存会把看不见的付费模型一起写进配置。
  const visible = new Set(models.map((model) => model.id))
  const picked = form.picked.filter((id) => visible.has(id))
  return {
    ...form,
    models,
    picked: picked.length > 0 ? picked : models.map((model) => model.id),
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
