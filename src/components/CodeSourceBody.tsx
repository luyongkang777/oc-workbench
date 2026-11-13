import { memo, useLayoutEffect, useRef, type ReactElement } from 'react'
import type { FileStat } from '../api/localfs'
import { coveringEntry, isFailure, type Entry } from './codeCache'
import { LINE_HEIGHT, splitMatches } from './codeWindow'

type Props = {
  stat: FileStat
  cache: Map<number, Entry>
  /** 要渲染的行区间（0 基，含 overscan）。区间由 CodeView 按布局模型算好。 */
  first: number
  last: number
  /** 区间上方的占位高度（px）。 */
  topPad: number
  /** 区间下方的占位高度（px）。 */
  bottomPad: number
  /** 自动换行：开时每行按视觉行数给最小高度。 */
  wrap: boolean
  /** 该行占几个视觉行（wrap 为 true 时使用）。 */
  rowsOf: (line: number) => number
  /**
   * 渲染后实测的结果。每项是 [行号, 视觉行数, 是否与模型不一致]：
   * 不一致的走回填补进布局表，一致的只记「已量过」，下次不再量。
   * 模型是估算：Chromium 的避头尾规则（`>`、`,`、`.` 前不折）会让个别行多折一次。
   */
  onMeasured: (entries: [number, number, boolean][]) => void
  /** 已经实测过的行（不必重复量）。 */
  isMeasured: (line: number) => boolean
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
  /** 查看区缩放：整块按此比例渲染。zoom 在滚动容器上时布局像素不变，虚拟滚动不用改。 */
  zoom?: number
}

/** 单次渲染最多实测多少行：滚动时新露头的行是有限的，别对整屏反复量。 */
const MEASURE_BUDGET = 400

/**
 * 源码虚拟列表：只渲染视口内的行，总高度靠上下占位块撑。
 *
 * 换行模式下每行高度不再是常量：最小高度 = 视觉行数 × 19px，内容真放不下时
 * 盒子自己长高（min-height 而不是 height）——宁可多占几像素，也不把字压住。
 * 真实行数随后回填给外层，滚动偏移按实测值重算。
 */
function CodeSourceBody({
  stat,
  cache,
  first,
  last,
  topPad,
  bottomPad,
  wrap,
  rowsOf,
  onMeasured,
  isMeasured,
  onScroll,
  attachScroll,
  onRetryPage,
  flashLine = null,
  query = '',
  matchLine = null,
  onDoubleClick,
  zoom = 1,
}: Props) {
  const rows: ReactElement[] = []
  const preRef = useRef<HTMLPreElement | null>(null)
  // 本轮渲染用的行数（0 基 → 视觉行），实测时用来比对
  const rendered = useRef(new Map<number, number>())
  rendered.current = new Map()

  for (let line = first; line <= last && line < stat.lineCount; line += 1) {
    const entry = coveringEntry(cache, line)
    const failed = entry && isFailure(entry) ? entry.error : null
    const text = entry && !isFailure(entry) ? entry.lines[line - entry.start] : undefined
    const visualRows = wrap && failed === null ? Math.max(1, rowsOf(line)) : 1
    if (wrap) rendered.current.set(line, visualRows)
    rows.push(
      <div
        className={`code-line${wrap ? ' wrap' : ''}${flashLine === line ? ' flash' : ''}${
          matchLine === line ? ' match' : ''
        }`}
        key={line}
        data-line={line}
        // 失败提示是整段中文，固定高度会压字：这种行不给最小高度
        style={
          wrap
            ? failed !== null
              ? undefined
              : { minHeight: visualRows * LINE_HEIGHT }
            : { height: LINE_HEIGHT }
        }
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

  // 实测：浏览器已经把行排好了，读 offsetHeight 就是真实高度（布局像素，不受 zoom 影响）。
  // 每行只量一次：量过的行（无论准不准）都会记下来，滚动时不会重复读，避免每帧强制重排。
  useLayoutEffect(() => {
    if (!wrap || document.hidden) return
    const pre = preRef.current
    if (!pre) return
    const entries: [number, number, boolean][] = []
    const nodes = pre.querySelectorAll<HTMLElement>('.code-line.wrap[data-line]')
    let budget = MEASURE_BUDGET
    for (const node of nodes) {
      if (budget <= 0) break
      const line = Number(node.dataset.line)
      if (!Number.isFinite(line) || isMeasured(line)) continue
      // 失败提示行没有 min-height（高度由内容决定），量了会把提示文案的行数写进模型
      const renderedRows = rendered.current.get(line)
      if (renderedRows === undefined) continue
      budget -= 1
      // 量文本本身而不是整个盒子：盒子有 min-height，量它会掩盖「估多了」的情况
      const target = node.querySelector<HTMLElement>('.code-text') ?? node
      const measured = Math.max(1, Math.round(target.offsetHeight / LINE_HEIGHT))
      entries.push([line, measured, measured !== renderedRows])
    }
    if (entries.length) onMeasured(entries)
  })

  return (
    <div
      className={`code-scroll${wrap ? ' wrap' : ''}`}
      ref={attachScroll}
      onScroll={onScroll}
      onDoubleClick={onDoubleClick}
      style={zoom !== 1 ? { zoom } : undefined}
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
      <pre className="code-block" ref={preRef}>
        <div style={{ height: topPad }} />
        {rows}
        <div style={{ height: bottomPad }} />
      </pre>
    </div>
  )
}

/**
 * memo 边界：聊天流式刷新、侧栏状态变化都会让 App 重渲染，
 * 但那跟代码区无关。props 全稳的前提下这里直接跳过 260 行 DOM 的对账。
 */
export default memo(CodeSourceBody)
