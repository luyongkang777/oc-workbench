import { authToken, withBase } from './base.ts'
import { localRequest } from './client'
import {
  formatTokens,
  quotaText,
  usageText,
  type ProviderQuota,
  type ProviderUsage,
} from '../components/providerQuotaFormat'

export type { ProviderQuota, ProviderUsage } from '../components/providerQuotaFormat'
export { formatTokens, quotaText, usageText } from '../components/providerQuotaFormat'

/**
 * 服务商额度 / 用量。
 *
 * 现实（2026-11-16 实测）：
 *   * **DeepSeek 官方**只有 `user/balance` 一个公开接口，能给金额；
 *   * **OpenCode Go / Command Code** 没有公开额度接口（一堆 404），
 *     官方文档让去控制台看 → 这边只能给链接，不编造数字；
 *   * 为了仍然有个可参考的「用了多少」，同时从 opencode 的统计接口
 *     （`/api/experimental/session/stats`）按 provider 汇总本机累计消耗。
 */

export async function getProviderQuota(id: string): Promise<ProviderQuota> {
  return localRequest<ProviderQuota>(
    `/local/provider/quota?id=${encodeURIComponent(id)}`,
    undefined,
    20_000,
  )
}

/**
 * 按 provider 汇总本机累计消耗。
 *
 * 拿不到统计（dev 没连 opencode、接口变更）时返回空表，界面降级为只显示额度文案。
 */
export async function getProviderUsage(root: string): Promise<Record<string, ProviderUsage>> {
  if (!root) return {}
  try {
    const token = authToken()
    const url = withBase(
      `/api/experimental/session/stats?location%5Bdirectory%5D=${encodeURIComponent(root)}`,
    )
    const res = await fetch(url, {
      headers: token ? { 'x-oc-token': token } : undefined,
      cache: 'no-store',
    })
    if (!res.ok) return {}
    const json = (await res.json()) as {
      data?: {
        models?: Array<{
          model?: { providerID?: string }
          steps?: number
          cost?: number
          tokens?: { input?: number; output?: number }
        }>
      }
    }
    const out: Record<string, ProviderUsage> = {}
    for (const item of json.data?.models ?? []) {
      const id = item.model?.providerID
      if (!id) continue
      const agg = out[id] ?? { tokens: 0, cost: 0, steps: 0 }
      agg.tokens += (item.tokens?.input ?? 0) + (item.tokens?.output ?? 0)
      agg.cost += item.cost ?? 0
      agg.steps += item.steps ?? 0
      out[id] = agg
    }
    return out
  } catch {
    return {}
  }
}
