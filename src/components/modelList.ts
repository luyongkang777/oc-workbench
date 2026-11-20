/**
 * 模型下拉里「该显示哪些模型」的判定（纯函数，node 里能直接单测）。
 *
 * 背景：opencode 有**内置 provider**（`opencode` / `opencode-go` / `anthropic`…），
 * 它们自带的模型和用户在「第三方 API 接入」里自己配的那批是**同一份模型**。
 * 实测这台机器上 `opencode` 与 `opencode-free` 都指向
 * `https://opencode.ai/inference/openai/v1`，下拉里同一个模型出现两次，
 * 用户根本分不清该点哪个。
 *
 * 所以规则是：**内置 provider 的模型不显示**，但保留一条例外——
 * 当前正在用的那条要留着，否则下拉里找不到它，切走之后就再也点不回来。
 */

/** 判定需要的最小形状（不依赖 ModelInfo，方便单测）。 */
export type SelectableModel = {
  id: string
  providerID: string
  name?: string
  /** 来自内置 provider */
  builtin?: boolean
}

export type CurrentModel = { id: string; providerID: string } | null | undefined

/**
 * 这条模型要不要出现在下拉里。
 *
 * `builtin` 为空/false 一律显示——**拿不到内置标记时宁可多显示**，
 * 别把用户自己配的模型藏掉。
 */
export function isSelectable(model: SelectableModel, current?: CurrentModel): boolean {
  if (!model.builtin) return true
  // 内置的：只有「当前正在用」的那条例外
  return Boolean(current && current.id === model.id && current.providerID === model.providerID)
}

/** 过滤出下拉里该显示的模型。 */
export function selectableModels<T extends SelectableModel>(
  models: T[],
  current?: CurrentModel,
): T[] {
  return models.filter((model) => isSelectable(model, current))
}

/** 按关键词筛选（名称 / id / providerID 都参与匹配）。 */
export function filterByKeyword<T extends SelectableModel>(models: T[], keyword: string): T[] {
  const text = (keyword ?? '').trim().toLowerCase()
  if (!text) return models
  return models.filter((model) =>
    `${model.name ?? ''} ${model.id} ${model.providerID}`.toLowerCase().includes(text),
  )
}
