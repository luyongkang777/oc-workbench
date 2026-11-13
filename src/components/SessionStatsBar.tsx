/**
 * 输入框下方的会话统计条。
 *
 * 两个读数，形态对齐 DeepSeek Harness 的 composer dock：
 *   ⊙ 1 轮 4 步 · 218 tok/s      ⛁ 38.3K tok · 缓存命中 67%
 *
 * 悬停展开明细，点击钉住（点外面或 Esc 收起）。没有数据的段直接省略，
 * 不显示「— tok/s」这种占位——空读数比不显示更像坏了。
 */
import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import {
  activitySummary,
  countsLabel,
  formatPercent,
  formatRate,
  formatStatSpan,
  formatTokenTotal,
  usageSummary,
  type SessionStats,
} from './sessionStats'

type Props = { stats: SessionStats }

type Which = 'activity' | 'usage'

export default function SessionStatsBar({ stats }: Props) {
  const [open, setOpen] = useState<null | { which: Which; pinned: boolean }>(null)
  const box = useRef<HTMLDivElement | null>(null)

  // 钉住时才监听外部点击 / Esc：悬停态跟着鼠标走，不需要额外的监听
  useEffect(() => {
    if (!open?.pinned) return
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!stats.known && stats.turns === 0 && stats.steps === 0) return null

  const activity = activitySummary(stats)
  const tokens = formatTokenTotal(stats.total)
  const usage = usageSummary(stats, tokens)
  const shown = open?.which ?? null

  function hover(which: Which) {
    setOpen((current) => (current?.pinned ? current : { which, pinned: false }))
  }

  function toggle(which: Which) {
    setOpen((current) =>
      current?.pinned && current.which === which ? null : { which, pinned: true },
    )
  }

  return (
    <div
      className="chat-stats"
      ref={box}
      onMouseLeave={() => setOpen((current) => (current?.pinned ? current : null))}
    >
      <button
        type="button"
        className={`chat-stat-chip${shown === 'activity' ? ' open' : ''}${
          stats.running ? ' running' : ''
        }`}
        data-composer-stat="activity"
        title={activity}
        aria-label={`会话进度：${activity}`}
        aria-expanded={shown === 'activity'}
        onMouseEnter={() => hover('activity')}
        onClick={() => toggle('activity')}
      >
        <Icon name="gauge" size={13} />
        <span className="chat-stat-text">{activity}</span>
      </button>

      <button
        type="button"
        className={`chat-stat-chip${shown === 'usage' ? ' open' : ''}`}
        data-composer-stat="usage"
        title={usage}
        aria-label={`Token 用量：${usage}`}
        aria-expanded={shown === 'usage'}
        onMouseEnter={() => hover('usage')}
        onClick={() => toggle('usage')}
      >
        <Icon name="layers" size={13} />
        <span className="chat-stat-text">{usage}</span>
      </button>

      {shown ? (
        <div className="chat-stat-pop" role="dialog" aria-label="会话统计">
          <div className="chat-stat-head">
            <span className="chat-stat-head-title">会话统计</span>
            <span className="chat-stat-head-counts">{countsLabel(stats)}</span>
          </div>

          {/* 本轮单独一行：会话累计在长对话里几乎不动，真正在变的是这一轮 */}
          <div className="chat-stat-turn">
            <span>
              本轮 <b>{stats.turnSteps}</b> 步
            </span>
            <span>
              生成{' '}
              <b>
                {formatTokenTotal(stats.turnOutput + stats.turnReasoning)}
              </b>
            </span>
            <span>
              用时 <b>{formatStatSpan(stats.turnMs)}</b>
            </span>
            <span>
              速度 <b>{formatRate(stats.tps) || '—'}</b>
            </span>
          </div>

          {stats.known ? (
            <>
              <div className="chat-stat-cols">
                <div className="chat-stat-col">
                  <div className="chat-stat-section">Token 用量</div>
                  <div className="chat-stat-rows">
                    <span>
                      <b>{formatTokenTotal(stats.input)}</b> 输入
                    </span>
                    <span>
                      <b>{formatTokenTotal(stats.cacheRead)}</b> 缓存读
                    </span>
                    <span>
                      <b>{formatTokenTotal(stats.cacheWrite)}</b> 缓存写
                    </span>
                    <span>
                      <b>{formatTokenTotal(stats.output)}</b> 输出
                    </span>
                  </div>
                </div>

                <div className="chat-stat-col">
                  <div className="chat-stat-section">耗时与速度</div>
                  <div className="chat-stat-rows">
                    <span title="等首 token + 生成正文">
                      <b>{formatStatSpan(stats.modelMs)}</b> 模型用时
                    </span>
                    <span title="工具执行区间之和">
                      <b>{formatStatSpan(stats.toolMs)}</b> 工具用时
                    </span>
                    <span title="每次请求从发起到首个字落地的平均时间">
                      <b>{stats.ttftMs === null ? '—' : formatStatSpan(stats.ttftMs)}</b> 首 token
                    </span>
                    <span title="输出 token ÷ 模型写正文的时间">
                      <b>{formatRate(stats.tps) || '—'}</b> 输出速度
                    </span>
                  </div>
                </div>
              </div>

              {stats.cacheHit !== null || stats.reasoning > 0 ? (
                <div className="chat-stat-foot">
                  {stats.cacheHit !== null ? (
                    <span>缓存命中 {formatPercent(stats.cacheHit)}</span>
                  ) : null}
                  {stats.cacheHit !== null && stats.reasoning > 0 ? <span>·</span> : null}
                  {stats.reasoning > 0 ? (
                    <span>思考 {formatTokenTotal(stats.reasoning)} 已计入输出</span>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <div className="chat-stat-note">这个会话还没跑过模型</div>
          )}
        </div>
      ) : null}
    </div>
  )
}
