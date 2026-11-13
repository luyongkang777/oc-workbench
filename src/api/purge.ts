import { localRequest } from './client'
import type { PurgeKeywordEntry, PurgeModelEntry } from './purgeMatch'

// 纯匹配逻辑拆在 purgeMatch.ts（零依赖，单测可直接 import）；这里原样透出，
// 调用方只认 `api/purge` 一个入口。
export type { PurgeKeywordEntry, PurgeModelEntry } from './purgeMatch'
export { DEFAULT_PURGE_KEYWORDS, matchPurgeKeyword, matchPurgeModel } from './purgeMatch'

/** 插件 state.json 的运行时统计（多实例共享，只用于展示，不当判定依据）。 */
export type PurgeRuntimeState = {
  requests?: number
  injects?: number
  lastAt?: number
  lastBytes?: number
  lastSource?: string
  updatedAt?: number
  [key: string]: unknown
}

/** `/local/purge/status` 的返回形状；dev 与外壳两套实现字段逐字一致。 */
export type PurgeStatus = {
  ok: boolean
  error?: string
  dataDir?: string
  pluginDir?: string
  pluginInstalled?: boolean
  configPath?: string
  configExists?: boolean
  configError?: string
  configMtimeMs?: number | null
  enabled: boolean
  injectDefault: boolean
  promptFile?: string
  promptPath?: string
  promptExists?: boolean
  promptBytes?: number
  perModel: PurgeModelEntry[]
  /** null = 配置里没写 keywordMap，插件按内置五项默认生效 */
  keywords: PurgeKeywordEntry[] | null
  temperature: number | null
  maxTokens: number | null
  toolsDeny: string[]
  verbose: boolean
  state: PurgeRuntimeState | null
}

export async function getPurgeStatus(signal?: AbortSignal): Promise<PurgeStatus> {
  return localRequest<PurgeStatus>('/local/purge/status', signal)
}

/** 只改 enabled；其余字段由外壳按磁盘原文保留。 */
export async function setPurgeEnabled(enabled: boolean): Promise<PurgeStatus> {
  return localRequest<PurgeStatus>('/local/purge/enabled', undefined, 20_000, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}
