import { useEffect, useRef, useState } from 'react'
import { contextHint, formatTokens, type ContextUsage } from './contextUsage'

type Props = {
  usage: ContextUsage
  compacting: boolean
  onCompact: () => void
}

/**
 * 顶栏的上下文用量：一个百分比小条 + 悬停/点击展开的明细浮层。
 *
 * 只报数，不催促——早期版本里有「还有更早的没加载」「加载更早的记录」这类提示，
 * 现在更早的记录会在滚到顶时自动补齐，浮层里不需要再多两个按钮和两行提醒。
 */
export default function ContextMeter({
  usage,
  compacting,
  onCompact,
}: Props) {
  const [open, setOpen] = useState<null | 'hover' | 'pinned'>(null)
  const box = useRef<HTMLDivElement | null>(null)
  // 压缩是一次可能好几分钟的请求：跑起来就得让人看见「还在跑、跑了多久」
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!compacting) {
      setElapsed(0)
      return
    }
    const startedAt = Date.now()
    setElapsed(0)
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 500)
    return () => window.clearInterval(timer)
  }, [compacting])

  useEffect(() => {
    if (open !== 'pinned') return
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

  const shown = open !== null
  const percentText = usage.known && usage.limit > 0 ? `${Math.round(usage.percent)}%` : '—'
  const fill = usage.known && usage.limit > 0 ? Math.min(100, usage.percent) : 0

  return (
    <div
      className="chat-context"
      ref={box}
      onMouseEnter={() => setOpen((current) => (current === 'pinned' ? current : 'hover'))}
      onMouseLeave={() =>
        // 压缩中不收起：正在跑的时候把进度面板关掉，等于什么反馈都没有
        setOpen((current) => (current === 'hover' && !compacting ? null : current))
      }
    >
      <button
        type="button"
        className={`chat-context-chip${shown ? ' open' : ''}`}
        title={contextHint(usage)}
        aria-label={contextHint(usage)}
        aria-expanded={shown}
        onClick={() => setOpen((current) => (current === 'pinned' ? null : 'pinned'))}
      >
        <span className="chat-context-bar">
          <span className="chat-context-fill" style={{ width: `${fill}%` }} />
        </span>
        <span className="chat-context-text">{percentText}</span>
      </button>

      {shown ? (
        <div className="chat-context-pop" role="dialog" aria-label="上下文用量">
          <div className="chat-context-head">{contextHint(usage)}</div>
          {usage.known ? (
            <div className="chat-context-rows">
              <span>
                <b>{formatTokens(usage.input)}</b> 输入
              </span>
              <span>
                <b>{formatTokens(usage.cacheRead)}</b> 缓存读
              </span>
              <span>
                <b>{formatTokens(usage.output)}</b> 输出
              </span>
            </div>
          ) : null}
          <div className="chat-context-actions">
            <button
              type="button"
              className={`chat-context-action${compacting ? ' running' : ''}`}
              onClick={onCompact}
              disabled={compacting}
            >
              {compacting ? `压缩中… ${elapsed}s` : '压缩上下文'}
            </button>
            {compacting ? (
              <span className="chat-context-note">正在重写历史，完成后聊天区会给出结果</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
