import { localRequest } from './client'

/** 时间范围：与外壳 `/local/usage?period=` 一致。 */
export type UsagePeriod = 'today' | '7d' | '30d' | 'all'

export type UsageTotals = {
  calls: number
  errors: number
  retried: number
  canceled: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  /** 估算费用（USD），只算认得出价格的调用 */
  cost: number
  /** 有 token 但认不出价格的调用数 */
  unpriced: number
}

/** 一个分组（客户端 / 服务商 / 模型）。 */
export type UsageGroup = UsageTotals & { id: string }

/** 图表的一根柱子（小时或一天）。 */
export type UsagePoint = {
  label: string
  /** 天的 `YYYY-MM-DD`；小时桶为空 */
  time: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  calls: number
  cost: number
}

export type UsageSummary = {
  period: UsagePeriod
  bucket: 'hour' | 'day'
  /** 数据源描述（网关日志 / 会话库 / 两者） */
  source: string
  generatedAt: string
  totals: UsageTotals
  /** 缓存命中率 0~1；没有提示词 token 时为 null */
  hitRate: number | null
  series: UsagePoint[]
  agents: UsageGroup[]
  providers: UsageGroup[]
  models: UsageGroup[]
}

export type UsageResult = ({ ok: true } & UsageSummary) | { ok: false; error: string }

/**
 * 读用量统计。
 *
 * 两个来源：magpie 的 `usage.jsonl`（走网关的调用）与 opencode 会话库
 * （本地会话，含不走网关的请求）。两者都没有时后端返回 `{ok:false,error}`。
 */
export async function getUsage(
  period: UsagePeriod,
  provider?: string,
  agent?: string,
): Promise<UsageResult> {
  const params = new URLSearchParams({ period })
  if (provider) params.set('provider', provider)
  if (agent) params.set('agent', agent)
  return localRequest<UsageResult>(`/local/usage?${params.toString()}`, undefined, 30_000)
}
