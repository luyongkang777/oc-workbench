import type { UsageSummary } from '../api/usage'
import {
  formatCost,
  formatPercent,
  formatUsageTokens,
  requestNote,
  tokensOf,
} from './usageFormat'

type Props = {
  summary: UsageSummary
  /** Token 是否含缓存（与 magpie 面板的开关同义） */
  withCache: boolean
  onToggleCache: () => void
}

/**
 * 四张汇总卡：Token / 请求 / 费用 / 缓存命中率。
 *
 * 口径与 magpie 的用量页一致：Token 默认含缓存（点标签可以切成「输入+输出」），
 * 费用是按 models.dev 单价估的，认不出价格的调用单独提示「未计价」。
 */
export default function UsageSummaryCards({ summary, withCache, onToggleCache }: Props) {
  const totals = summary.totals
  return (
    <section className="usage-cards">
      <div className="usage-card">
        <div className="usage-card-head">
          <span className="usage-card-label">Token</span>
          <button
            type="button"
            className={`usage-card-pick${withCache ? ' on' : ''}`}
            onClick={onToggleCache}
            title={withCache ? '点一下改成「不含缓存」' : '点一下改成「含缓存」'}
          >
            {withCache ? '含缓存' : '不含缓存'}
          </button>
        </div>
        <b className="usage-card-value">{formatUsageTokens(tokensOf(totals, withCache))}</b>
        <span className="usage-card-sub">
          输入 {formatUsageTokens(totals.input)} · 输出 {formatUsageTokens(totals.output)}
        </span>
        <span className="usage-card-sub">
          缓存 {formatUsageTokens(totals.cacheRead)}
          {totals.cacheWrite > 0 ? ` · 写入 ${formatUsageTokens(totals.cacheWrite)}` : ''}
        </span>
      </div>

      <div className="usage-card">
        <span className="usage-card-label">请求</span>
        <b className="usage-card-value">{formatUsageTokens(totals.calls)}</b>
        <span className={`usage-card-sub${totals.errors > 0 ? ' bad' : ''}`}>
          {totals.calls === 0 ? '没有请求' : requestNote(totals) || '全部成功'}
        </span>
      </div>

      <div className="usage-card">
        <span className="usage-card-label">费用</span>
        <b className="usage-card-value">{formatCost(totals.cost)}</b>
        <span className="usage-card-sub">
          {totals.unpriced > 0 ? `${totals.unpriced} 次调用未计价` : '按模型单价估算'}
        </span>
      </div>

      <div className="usage-card">
        <span className="usage-card-label">缓存命中率</span>
        <b className="usage-card-value">{formatPercent(summary.hitRate)}</b>
        <span className="usage-card-sub">占提示词</span>
      </div>
    </section>
  )
}
