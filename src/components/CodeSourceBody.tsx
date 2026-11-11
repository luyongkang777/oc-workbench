import type { ReactElement } from 'react'
import type { FileStat } from '../api/localfs'
import { coveringEntry, isFailure, type Entry } from './codeCache'
import { LINE_HEIGHT, splitMatches, visibleRange } from './codeWindow'

type Props = {
  stat: FileStat
  cache: Map<number, Entry>
  scrollTop: number
  viewportHeight: number
  scale: number
  onScroll: () => void
  attachScroll: (node: HTMLDivElement | null) => void
  onRetryPage: (start: number) => void
  /** 跳转后高亮的行（0 基），用于定位反馈。 */
  flashLine?: number | null
  /** 搜索关键词；非空时高亮本行内的命中片段。 */
  query?: string
  /** 当前搜索命中行（0 基）。 */
  matchLine?: number | null
  /** 双击代码区（进入编辑）。 */
  onDoubleClick?: () => void
}

/** 源码虚拟列表：只渲染视口内的行，总高度靠上下占位块撑。 */
export default function CodeSourceBody({
  stat,
  cache,
  scrollTop,
  viewportHeight,
  scale,
  onScroll,
  attachScroll,
  onRetryPage,
  flashLine = null,
  query = '',
  matchLine = null,
  onDoubleClick,
}: Props) {
  const { first, last } = visibleRange(scrollTop, viewportHeight, stat.lineCount, scale)
  const topPad = first * LINE_HEIGHT * scale
  const bottomPad = Math.max(0, (stat.lineCount - last - 1) * LINE_HEIGHT * scale)
  const rows: ReactElement[] = []

  for (let line = first; line <= last; line += 1) {
    const entry = coveringEntry(cache, line)
    const failed = entry && isFailure(entry) ? entry.error : null
    const text = entry && !isFailure(entry) ? entry.lines[line - entry.start] : undefined
    rows.push(
      <div
        className={`code-line${flashLine === line ? ' flash' : ''}${
          matchLine === line ? ' match' : ''
        }`}
        key={line}
        style={{ height: LINE_HEIGHT }}
      >
        <span className="line-no">{line + 1}</span>
        {failed !== null ? (
          <span
            className="code-text code-failed"
            title="点击重试"
            onClick={() => entry && onRetryPage(entry.start)}
          >
            （本页加载失败，点击重试：{failed}）
          </span>
        ) : (
          <span className={`code-text${text === undefined ? ' pending' : ''}`}>
            {text === undefined
              ? ' '
              : query
                ? splitMatches(text, query).map((part, index) =>
                    part.match ? (
                      <mark className="code-hit" key={index}>
                        {part.text}
                      </mark>
                    ) : (
                      <span key={index}>{part.text}</span>
                    ),
                  )
                : text}
          </span>
        )}
      </div>,
    )
  }

  return (
    <div
      className="code-scroll"
      ref={attachScroll}
      onScroll={onScroll}
      onDoubleClick={onDoubleClick}
      tabIndex={0}
      onKeyDown={(event) => {
        // 焦点在代码区时 Home/End 直达首尾；其余按键交给浏览器原生滚动。
        if (event.key === 'Home') {
          event.preventDefault()
          event.currentTarget.scrollTop = 0
        } else if (event.key === 'End') {
          event.preventDefault()
          event.currentTarget.scrollTop = event.currentTarget.scrollHeight
        }
      }}
      aria-label="代码内容"
    >
      <pre className="code-block">
        <div style={{ height: topPad }} />
        {rows}
        <div style={{ height: bottomPad }} />
      </pre>
    </div>
  )
}
