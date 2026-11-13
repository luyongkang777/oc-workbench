/**
 * 破甲匹配逻辑（纯函数，零依赖）。
 *
 * 从 `purge.ts` 拆出来只为一件事：让单测能直接 import 它——`purge.ts` 会拉进
 * `./client`，Node 的 ESM 解析不了无扩展名导入。
 *
 * 规则必须与插件 `core.mts` 保持一致：
 *   1. perModel 精确匹配（`providerID/modelID`、`modelID`、以及 modelID 后缀）
 *   2. keywordMap 关键词匹配（模型 id 包含关键词，大小写不敏感，长词优先）
 *   3. injectDefault 兜底
 */

/** perModel 里的一条：模型 key → 提示词文件。 */
export type PurgeModelEntry = {
  key: string
  file: string
  path: string
  exists: boolean
  bytes: number
}

/** 关键词命中表的一条：模型 id 含 keyword 就用 file。 */
export type PurgeKeywordEntry = {
  keyword: string
  file: string
  path?: string
  exists?: boolean
  bytes?: number
}

/**
 * 插件内置的关键词表。配置里没写 `keywordMap` 时插件就用这五项，
 * 前端据此做同样的兜底判断（只在 status.keywords === null 时用到）。
 */
export const DEFAULT_PURGE_KEYWORDS: PurgeKeywordEntry[] = [
  { keyword: 'glm', file: 'prompts/glm.md' },
  { keyword: 'gpt', file: 'prompts/gpt.md' },
  { keyword: 'deepseek', file: 'prompts/deepseek.md' },
  { keyword: 'claude', file: 'prompts/claude.md' },
  { keyword: 'grok', file: 'prompts/grok.md' },
]

/**
 * 按插件 `perModelPrompt` 的规则匹配当前模型。
 *
 * 三种 key 写法都支持：`providerID/modelID`、`modelID`、以及 modelID 的后缀。
 * 前端自己算一遍是为了在开关上直接标出「当前模型会不会注入」——插件匹配失败时
 * 是完全静默的，只靠开关本身看不出来。
 */
export function matchPurgeModel(
  perModel: PurgeModelEntry[] | undefined,
  providerID: string | undefined,
  modelID: string | undefined,
): PurgeModelEntry | null {
  const entries = perModel ?? []
  if (!entries.length) return null
  const pid = String(providerID ?? '')
  const mid = String(modelID ?? '')
  if (!pid && !mid) return null
  const full = pid && mid ? `${pid}/${mid}` : mid

  for (const entry of entries) {
    if (entry.key === full || entry.key === mid) return entry
  }
  for (const entry of entries) {
    if (mid && (mid.endsWith(entry.key) || full.endsWith(entry.key))) return entry
  }
  return null
}

/**
 * 关键词命中：模型 id（不含 provider）里包含哪个关键词，就用它对应的正文。
 * 与插件 `keywordPrompt()` 对齐：大小写不敏感、长关键词优先。
 */
export function matchPurgeKeyword(
  keywords: PurgeKeywordEntry[] | null | undefined,
  modelID: string | undefined,
): PurgeKeywordEntry | null {
  const list = keywords ?? DEFAULT_PURGE_KEYWORDS
  if (!list.length) return null
  const mid = String(modelID ?? '').toLowerCase()
  if (!mid) return null
  const sorted = [...list].sort((left, right) => right.keyword.length - left.keyword.length)
  for (const entry of sorted) {
    if (mid.includes(entry.keyword.toLowerCase())) return entry
  }
  return null
}
