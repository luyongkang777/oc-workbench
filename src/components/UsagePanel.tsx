import { useCallback, useEffect, useState } from 'react'

import type { UsagePeriod } from '../api/usage'
import { useUsage } from '../hooks/useUsage'
import { Icon } from './Icon'
import UsageBreakdown from './UsageBreakdown'
import UsageChart from './UsageChart'
import UsageSummaryCards from './UsageSummaryCards'
import { sourceName } from './usageFormat'

const PERIODS: Array<[UsagePeriod, string]> = [
  ['today', '今天'],
  ['7d', '7 天'],
  ['30d', '30 天'],
  ['all', '全部'],
]

/** Token 含不含缓存的偏好（与 magpie 面板的开关同义，默认含缓存）。 */
const CACHE_KEY = 'oc.usage.withCache'

function readWithCache(): boolean {
  try {
    return window.localStorage.getItem(CACHE_KEY) !== '0'
  } catch {
    return true
  }
}

type Props = {
  open: boolean
  onClose: () => void
}

/**
 * 用量面板（顶栏仪表按钮）。
 *
 * 数据来自 magpie 的 `usage.jsonl`（**只含走网关的调用**）：装了 magpie
 * 并跑过请求才有数字。magpie 自己的用量页还会合并各客户端的会话日志，
 * 所以两边数字会有差异，这里在说明里写清楚。
 */
export default function UsagePanel({ open, onClose }: Props) {
  const usage = useUsage(open)
  const [withCache, setWithCache] = useState(readWithCache)
  const summary = usage.data?.ok ? usage.data : null
  const error = usage.data && !usage.data.ok ? usage.data.error : null

  const toggleCache = useCallback(() => {
    setWithCache((current) => {
      const next = !current
      try {
        window.localStorage.setItem(CACHE_KEY, next ? '1' : '0')
      } catch {
        // 隐私模式忽略
      }
      return next
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <>
      <div
        className={`usage-mask${open ? ' open' : ''}`}
        onClick={onClose}
        aria-hidden={open ? undefined : true}
      />
      <aside className={`usage-panel${open ? ' open' : ''}`} aria-label="用量">
        <header className="usage-head">
          <span className="usage-title">用量</span>
          <button type="button" className="usage-close" onClick={onClose} title="关闭（Esc）">
            <Icon name="close" size={13} />
          </button>
        </header>

        <div className="usage-body">
          <div className="usage-filters">
            <div className="usage-tabs" role="tablist" aria-label="时间范围">
              {PERIODS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={usage.period === value}
                  className={`usage-tab${usage.period === value ? ' active' : ''}`}
                  onClick={() => usage.setPeriod(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <select
              className="usage-select"
              value={usage.provider}
              onChange={(event) => usage.setProvider(event.target.value)}
              aria-label="按服务商筛选"
            >
              <option value="">全部供应商</option>
              {(summary?.providers ?? []).map((group) => (
                <option key={group.id} value={group.id}>
                  {sourceName(group.id, 'provider')}
                </option>
              ))}
            </select>
            {usage.loading ? <span className="usage-loading">读取中…</span> : null}
            <button
              type="button"
              className="usage-refresh"
              onClick={usage.refresh}
              disabled={usage.loading}
              title="重新读日志"
              aria-label="刷新用量"
            >
              <Icon name="refresh" size={13} />
            </button>
          </div>

          <div className="usage-note">
            统计 magpie 网关日志 + 本机 opencode 会话；magpie 自己的用量页还会合并其它客户端的日志，两边数字会略有差异。
          </div>

          {error ? <div className="usage-error">{error}</div> : null}
          {!summary && !error ? (
            <div className="usage-empty">{usage.loading ? '读取中…' : '还没有数据'}</div>
          ) : null}

          {summary && summary.totals.calls === 0 ? (
            <div className="usage-empty">
              这个时间范围没有调用记录。今天还没请求的话切「7 天」或「全部」看看。
            </div>
          ) : null}

          {summary ? (
            <>
              <UsageSummaryCards summary={summary} withCache={withCache} onToggleCache={toggleCache} />
              <UsageChart summary={summary} withCache={withCache} />
              <UsageBreakdown
                summary={summary}
                onlyProvider={usage.provider || undefined}
                withCache={withCache}
              />
              <div className="usage-path" title={summary.source}>
                数据源：{summary.source}
              </div>
            </>
          ) : null}
        </div>
      </aside>
    </>
  )
}
