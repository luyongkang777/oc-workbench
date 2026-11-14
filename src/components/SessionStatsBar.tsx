/**
 * 输入框下方的会话统计条。
 *
 * 两个读数，形态对齐 DeepSeek Harness 的 composer dock：
 *   ⊙ 1 轮 4 步 · 218 tok/s      ⛁ 38.3K tok · 缓存命中 67%
 *
 * 有 MCP 数据时再接一个读数：
 *   ⚡ MCP 8/30   ← 已连接/总数，悬停或点击展开看每个服务器的状态
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
import {
  mcpChipLabel,
  mcpChipTitle,
  mcpErrorHint,
  mcpStatusText,
  mcpTone,
  sortMcpServers,
  summarizeMcp,
  type McpServerInfo,
} from './mcpStatus'
import type { McpServersState } from '../hooks/useMcpServers'

type Props = {
  stats: SessionStats
  /** MCP 服务器状态；不传就不显示这个读数（终端等场景用不到） */
  mcp?: McpServersState
}

type Which = 'activity' | 'usage' | 'mcp'

/** MCP 明细：异常排前面，每条一行；失败原因压成一行，全文进 title。 */
function McpPanel({ state }: { state: McpServersState }) {
  const summary = summarizeMcp(state.servers)
  const list = sortMcpServers(state.servers)

  return (
    <div className="chat-stat-pop chat-stat-pop-mcp" role="dialog" aria-label="MCP 服务器">
      <div className="chat-stat-head">
        <span className="chat-stat-head-title">MCP 服务器</span>
        <span className="chat-stat-head-counts">
          已连接 {summary.connected}/{summary.total}
          {summary.broken > 0 ? ` · ${summary.broken} 个异常` : ''}
          {summary.pending > 0 ? ` · ${summary.pending} 个连接中` : ''}
        </span>
      </div>

      {state.error ? <div className="chat-stat-note chat-stat-mcp-error">{state.error}</div> : null}

      <div className="chat-stat-mcp-list">
        {list.length === 0 ? (
          <div className="chat-stat-note">
            {state.loading ? '正在检测…' : '没有配置 MCP 服务器'}
          </div>
        ) : (
          list.map((server) => <McpRow key={server.name} server={server} />)
        )}
      </div>

      <div className="chat-stat-foot chat-stat-mcp-foot">
        <span>{state.loading ? '检测中…' : '状态来自服务端最近一次连接结果'}</span>
        <button
          type="button"
          className="chat-stat-refresh"
          onClick={state.refresh}
          disabled={state.loading}
        >
          重新检测
        </button>
      </div>
    </div>
  )
}

function McpRow({ server }: { server: McpServerInfo }) {
  const tone = mcpTone(server.status)
  const label = server.title?.trim() || server.name
  const error = mcpErrorHint(server.error)

  return (
    <div
      className={`chat-stat-mcp-item ${tone}`}
      title={server.error ? `${label}\n${server.error}` : `${label}：${mcpStatusText(server.status)}`}
    >
      <span className={`status-dot ${tone}`} aria-hidden="true" />
      <span className="chat-stat-mcp-name">{label}</span>
      <span className="chat-stat-mcp-state">{mcpStatusText(server.status)}</span>
      {error ? <span className="chat-stat-mcp-err">{error}</span> : null}
    </div>
  )
}

export default function SessionStatsBar({ stats, mcp }: Props) {
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

  const mcpSummary = mcp ? summarizeMcp(mcp.servers) : null
  const mcpReady = mcpSummary !== null && mcpSummary.total > 0

  // 三个读数都没东西可显示时整条不渲染
  if (!mcpReady && !stats.known && stats.turns === 0 && stats.steps === 0) return null

  const activity = activitySummary(stats)
  const tokens = formatTokenTotal(stats.total)
  const usage = usageSummary(stats, tokens)
  const shown = open?.which ?? null

  function hover(which: Which) {
    setOpen((current) => (current?.pinned ? current : { which, pinned: false }))
  }

  function toggle(which: Which) {
    // 点开 MCP 就是想知道现在连上没有：顺手重新检测一次。
    // 悬停不刷（鼠标划过就发请求太吵），点开才刷。
    const stayingOpen = open?.pinned && open.which === which
    if (which === 'mcp' && mcp && !stayingOpen) mcp.refresh()
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

      {mcp && mcpSummary && mcpReady ? (
        <button
          type="button"
          className={`chat-stat-chip${shown === 'mcp' ? ' open' : ''}${
            mcpSummary.broken > 0 ? ' bad' : ''
          }`}
          data-composer-stat="mcp"
          title={mcpChipTitle(mcpSummary)}
          aria-label={mcpChipTitle(mcpSummary)}
          aria-expanded={shown === 'mcp'}
          onMouseEnter={() => hover('mcp')}
          onClick={() => toggle('mcp')}
        >
          <Icon name="plug" size={13} />
          <span className="chat-stat-text">{mcpChipLabel(mcpSummary)}</span>
        </button>
      ) : null}

      {shown === 'mcp' && mcp ? <McpPanel state={mcp} /> : null}

      {shown && shown !== 'mcp' ? (
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
