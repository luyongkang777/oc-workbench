import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DIFF_LINE_HEIGHT, diffWindow } from './diffWindow'
import { measureCodeMetrics, type CodeMetrics } from './textMetrics'
import {
  buildWrapLayout,
  rowOffsetOf,
  visibleRangeIn,
  wrapRows,
  type WrapLayout,
} from './wrapLayout'

/** `.diff-line` 左右各 12px 内边距：算可用宽度时要扣掉。 */
const DIFF_TEXT_INSET = 24
/**
 * 超过这么多行就走 Worker 算折行。
 * 逐字模拟大约 0.002ms/行，3000 行 ≈ 6ms 还能忍；再多就该挪去别的线程了。
 */
const SYNC_MAX_LINES = 3000

export function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

/** 在主线程把一份 patch 的每行折行数算出来（小 patch 用，省掉 Worker 往返）。 */
function measureRows(lines: string[], availPx: number, metrics: CodeMetrics): Uint16Array {
  const rows = new Uint16Array(lines.length)
  for (let i = 0; i < lines.length; i += 1) rows[i] = wrapRows(lines[i], availPx, metrics)
  return rows
}

/**
 * 单个文件的 patch：虚拟滚动，只渲染视口里那几十行。
 *
 * 真实仓库一次工作区改动可能有几万行 diff（单个文件 6 万行实测过），
 * 全量 map 成 div 会塞进 6 万个节点、首帧 3 秒以上，并且滚动掉帧。
 * 这里只渲染视口内的行，滚动位置靠 useMemo 算出的偏移表定位。
 * 行数计算对 6 万行的 patch 要 100ms 以上，所以超过 3000 行时
 * 整段丢进 Worker，主线程只接收一个可转移的 Uint16Array。
 *
 * `key` 由调用方给成「节点 + 文件名」：切文件或切节点时整块重挂载，
 * 滚动位置自然回到顶部。
 *
 * 抽成独立文件是给「修改记录」面板复用：那边要按历史轮次看 diff，
 * 渲染逻辑和审查面板完全一样，没必要抄一份。
 */
export default function DiffBody({ patch, wrap }: { patch: string; wrap: boolean }) {
  // 统一去掉 CRLF 的行尾回车：git 在 Windows 上给的 patch 是 \r\n，
  // 留着 \r 会让复制出来和行宽都不对
  const lines = useMemo(() => patch.split(/\r?\n/), [patch])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(600)
  const [availPx, setAvailPx] = useState(0)
  const [metrics, setMetrics] = useState<CodeMetrics | null>(null)
  // 每行的视觉行数；null = 还没算出来（先按不换行渲染，算好再切）
  const [rows, setRows] = useState<Uint16Array | null>(null)

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const update = () => {
      setViewport(node.clientHeight || 600)
      setAvailPx(Math.max(0, node.clientWidth - DIFF_TEXT_INSET))
      const body = bodyRef.current
      if (!body) return
      const next = measureCodeMetrics(body)
      setMetrics((prev) =>
        prev && prev.charWidth === next.charWidth && prev.wideWidth === next.wideWidth
          ? prev
          : next,
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => {
      observer.disconnect()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // 滚动用 rAF 合并：一次滚动只 setState 一次
  const onScroll = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop)
    })
  }, [])

  // 折行行数：小 patch 就地算，大 patch 交给 Worker。
  useEffect(() => {
    if (!wrap || availPx < 40 || !metrics) {
      setRows(null)
      return
    }
    if (lines.length <= SYNC_MAX_LINES) {
      setRows(measureRows(lines, availPx, metrics))
      return
    }

    let worker: Worker | null = null
    let cancelled = false
    try {
      worker = new Worker(new URL('../workers/diffWrap.worker.ts', import.meta.url), {
        type: 'module',
      })
    } catch {
      worker = null
    }
    if (!worker) {
      // 线程起不来（老内核/打包异常）：退回主线程算一次，宁可卡一下也别不换行
      setRows(measureRows(lines, availPx, metrics))
      return
    }

    const id = Date.now() + Math.random()
    worker.onmessage = (event: MessageEvent<{ id: number; rows: Uint16Array }>) => {
      if (event.data.id !== id) return
      if (!cancelled) setRows(event.data.rows)
      worker?.terminate()
    }
    worker.onerror = () => {
      worker?.terminate()
      if (!cancelled) setRows(measureRows(lines, availPx, metrics))
    }
    worker.postMessage({ id, patch, availPx, metrics })

    return () => {
      cancelled = true
      worker?.terminate()
    }
  }, [wrap, availPx, metrics, patch, lines])

  const layout = useMemo<WrapLayout | null>(() => {
    if (!wrap || !rows || rows.length !== lines.length) return null
    const known: [number, number][] = []
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i] > 1) known.push([i, rows[i]])
    }
    return buildWrapLayout(lines.length, known, DIFF_LINE_HEIGHT)
  }, [wrap, rows, lines.length])

  const win = useMemo(() => {
    if (!layout) return diffWindow(lines.length, scrollTop, viewport)
    const range = visibleRangeIn(layout, scrollTop, viewport)
    const per = DIFF_LINE_HEIGHT * layout.scale
    return {
      first: range.first,
      last: range.last + 1,
      offset: rowOffsetOf(layout, range.first) * per,
      height: layout.height,
    }
  }, [layout, lines.length, scrollTop, viewport])

  return (
    <div className={`diff-scroll${layout ? ' wrap' : ''}`} ref={scrollRef} onScroll={onScroll}>
      <div className="diff-body" ref={bodyRef} style={{ height: win.height }}>
        <div style={{ transform: `translateY(${win.offset}px)` }}>
          {lines.slice(win.first, win.last).map((line, index) => {
            const absolute = win.first + index
            const visualRows = layout ? Math.max(1, rows?.[absolute] ?? 1) : 1
            return (
              <div
                className={`diff-line ${lineClass(line)}${layout ? ' wrap' : ''}`}
                key={absolute}
                // 最小高度而不是固定高度：浏览器真多折了一行时盒子自己长高，不压字
                style={layout ? { minHeight: visualRows * DIFF_LINE_HEIGHT } : undefined}
              >
                {line || ' '}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
