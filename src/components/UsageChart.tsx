import { useState } from 'react'

import type { UsageSummary } from '../api/usage'
import {
  barHeight,
  barTitle,
  formatCost,
  formatUsageTokens,
  labelStep,
  outputShare,
  pointValue,
  seriesPeak,
  type UsageMetric,
} from './usageFormat'

const METRICS: Array<[UsageMetric, string]> = [
  ['token', 'Token'],
  ['cost', '费用'],
  ['calls', '请求'],
]

/** 指标值的简短显示：柱子本身不写字，标签行里给峰值。 */
function peakText(value: number, metric: UsageMetric): string {
  if (metric === 'cost') return formatCost(value)
  return formatUsageTokens(value)
}

/**
 * 时间序列柱状图（纯 CSS，不引图表库）。
 *
 * Token 模式下输入在下、输出在上（输出占比按含/不含缓存的总量算）；
 * 费用 / 请求是单色柱。
 */
export default function UsageChart({
  summary,
  withCache,
}: {
  summary: UsageSummary
  withCache: boolean
}) {
  const [metric, setMetric] = useState<UsageMetric>('token')
  const points = summary.series
  const rawPeak = seriesPeak(points, metric, withCache)
  // 归一化用 1 防除零；显示时 0 表示「这个范围没有数据」
  const peak = rawPeak > 0 ? rawPeak : 1
  const step = labelStep(points.length)
  // 桶很多（「全部」最多 180 天）时保证每根柱子有最小宽度，横向滚动
  const minWidth = `${Math.max(points.length * 6, 100)}px`

  return (
    <section className="usage-chart">
      <div className="usage-chart-head">
        <div className="usage-chart-tabs" role="tablist" aria-label="图表指标">
          {METRICS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={metric === value}
              className={`usage-chart-tab${metric === value ? ' active' : ''}`}
              onClick={() => setMetric(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="usage-chart-peak">
          {rawPeak > 0 ? `峰值 ${peakText(rawPeak, metric)}` : '峰值 —'}
        </span>
      </div>

      <div className="usage-scroll">
        <div className="usage-bars" style={{ minWidth }}>
          {points.map((point, index) => {
            const height = barHeight(point, metric, peak, withCache)
            const share = outputShare(point, metric, withCache)
            return (
              <div
                key={`${point.label}-${index}`}
                className={`usage-bar${pointValue(point, metric, withCache) > 0 ? '' : ' empty'}`}
                title={barTitle(point, summary.bucket, withCache)}
              >
                {share > 0 ? <i className="usage-bar-out" style={{ height: `${height * share}%` }} /> : null}
                <i className="usage-bar-in" style={{ height: `${height * (1 - share)}%` }} />
              </div>
            )
          })}
        </div>

        <div className="usage-labels" style={{ minWidth }}>
          {points.map((point, index) => (
            <span key={`${point.label}-${index}`} className="usage-label">
              {index % step === 0 ? point.label : ''}
            </span>
          ))}
        </div>
      </div>

      {metric === 'token' ? (
        <div className="usage-legend">
          <span>
            <i className="usage-dot in" /> 输入{withCache ? '+缓存' : ''}
          </span>
          <span>
            <i className="usage-dot out" /> 输出
          </span>
        </div>
      ) : null}
    </section>
  )
}
