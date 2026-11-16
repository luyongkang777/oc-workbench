import { useState } from 'react'

import type { UsageGroup, UsageSummary } from '../api/usage'
import {
  formatCost,
  formatPercent,
  formatUsageTokens,
  hitRateOf,
  sourceName,
  tokensOf,
} from './usageFormat'

type Kind = 'agents' | 'providers' | 'models'

const KINDS: Array<[Kind, string]> = [
  ['agents', '客户端'],
  ['providers', '服务商'],
  ['models', '模型'],
]

/**
 * 分组明细：客户端 / 服务商 / 模型三选一，按 token 从多到少。
 *
 * 每行给：名称、token、占比条、输入输出缓存明细、命中率、费用。
 * `onlyProvider` 是供应商筛选值——后端的分组列表是全量（要喂下拉菜单），
 * 这里按当前筛选只显示那一家，避免和上面的总计对不上。
 */
export default function UsageBreakdown({
  summary,
  onlyProvider,
  withCache,
}: {
  summary: UsageSummary
  onlyProvider?: string
  withCache: boolean
}) {
  const [kind, setKind] = useState<Kind>('providers')
  const groups =
    kind === 'agents'
      ? summary.agents
      : kind === 'providers'
        ? onlyProvider
          ? summary.providers.filter((group) => group.id === onlyProvider)
          : summary.providers
        : summary.models
  const total = tokensOf(summary.totals, withCache)

  return (
    <section className="usage-breakdown">
      <div className="usage-chart-head">
        <div className="usage-chart-tabs" role="tablist" aria-label="分组方式">
          {KINDS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={kind === value}
              className={`usage-chart-tab${kind === value ? ' active' : ''}`}
              onClick={() => setKind(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0 ? <div className="usage-empty">这个范围没有数据</div> : null}

      {groups.map((group) => {
        const tokens = tokensOf(group, withCache)
        const share = total > 0 ? Math.min(100, (tokens / total) * 100) : 0
        const hit = hitRateOf(group)
        const name = sourceName(
          group.id,
          kind === 'agents' ? 'agent' : kind === 'providers' ? 'provider' : 'model',
        )
        return (
          <div className="usage-source" key={group.id}>
            <div className="usage-source-head">
              <span className="usage-source-name" title={group.id}>
                {name}
              </span>
              <span className="usage-source-tokens">{formatUsageTokens(tokens)}</span>
            </div>
            <div className="usage-source-bar">
              <i style={{ width: `${share > 0 ? Math.max(1.5, share) : 0}%` }} />
            </div>
            <div className="usage-source-sub">
              输入 {formatUsageTokens(group.input)} · 输出 {formatUsageTokens(group.output)}
              {group.cacheRead > 0 ? ` · 缓存 ${formatUsageTokens(group.cacheRead)}` : ''}
              {hit !== null && group.cacheRead > 0 ? ` · 命中率 ${formatPercent(hit)}` : ''}
            </div>
            <div className="usage-source-cost">
              {formatCost(group.cost)}
              {group.errors > 0 ? <span className="bad"> · {group.errors} 次失败</span> : null}
              {group.unpriced > 0 ? <span className="muted"> · {group.unpriced} 未计价</span> : null}
            </div>
          </div>
        )
      })}
    </section>
  )
}
