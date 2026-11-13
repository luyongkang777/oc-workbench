import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { buildOffsets, computeWindow, indexAt, isNearBottom } from './turnWindow'

/** 未测量轮次的高度估计：和 CSS 的 contain-intrinsic-size 保持同一个值。 */
const ESTIMATE = 260
/** 视口上下各多挂几轮：滚动时下一屏已经在，不会先看到空白。 */
const OVERSCAN = 3
/**
 * 贴底容差。只留几像素吸收亚像素误差 —— 给大了（比如 80px），用户往上翻半屏
 * 仍然会被判成贴底，流式输出一来就被拽回底部。
 */
const STICK_SLACK = 12

export type TurnWindowState = {
  start: number
  end: number
  topPad: number
  bottomPad: number
  /** 估算 + 实测混合后的总高度 */
  total: number
  /** 挂到列表容器的 ref（测量子节点高度用） */
  containerRef: RefObject<HTMLDivElement>
}

/**
 * 只挂载视口附近的轮次。
 *
 * 三个回调各管一件事：
 *   - 滚动 / 容器尺寸变化 → 重算窗口（每帧最多一次）
 *   - 子节点高度变化 → 更新高度表（实测替换估算）
 *   - 高度表变了 → 贴底时重新对齐、非贴底时保住正在看的那一轮
 *
 * 高度表放在 ref 里、用 version 触发重算：测量回调很密（流式时每帧都可能
 * 有一轮在长高），直接 setState 一个 Map 会让每次回调都排队一次渲染。
 */
export function useTurnWindow(
  turns: readonly { id: string }[],
  scrollRef: RefObject<HTMLDivElement | null>,
  enabled = true,
): TurnWindowState {
  const heightsRef = useRef(new Map<string, number>())
  const containerRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<number | null>(null)
  const [version, setVersion] = useState(0)
  const [viewport, setViewport] = useState({ top: 0, height: 0 })

  const ids = useMemo(() => turns.map((turn) => turn.id), [turns])
  // version 参与依赖：实测高度写进 ref 后靠它把前缀和重算一遍
  const offsets = useMemo(
    () => buildOffsets(ids, heightsRef.current, ESTIMATE),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids, version],
  )
  const total = offsets[offsets.length - 1] ?? 0
  const range = useMemo(
    () => computeWindow(offsets, viewport.top, viewport.height, OVERSCAN),
    [offsets, viewport],
  )

  const sync = useCallback(() => {
    frameRef.current = null
    const el = scrollRef.current
    if (!el) return
    const top = el.scrollTop
    const height = el.clientHeight
    setViewport((prev) => (prev.top === top && prev.height === height ? prev : { top, height }))
  }, [scrollRef])

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(sync)
  }, [sync])

  // 滚动 + 容器尺寸变化
  useEffect(() => {
    if (!enabled) return
    const el = scrollRef.current
    if (!el) return
    sync()
    el.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', schedule)
      observer.disconnect()
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      if (measureFrame.current !== null) window.cancelAnimationFrame(measureFrame.current)
      measureFrame.current = null
    }
  }, [scrollRef, schedule, sync])

  // 测量已挂载轮次的高度。窗口变化时重新纳入新节点；同一窗口内长高由
  // 已有 observer 继续上报，不重建。
  const { start, end } = range
  useLayoutEffect(() => {
    if (!enabled) return
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver((entries) => {
      const heights = heightsRef.current
      let changed = false
      for (const entry of entries) {
        const node = entry.target as HTMLElement
        const id = node.dataset.turnId
        if (!id) continue
        const box = entry.borderBoxSize?.[0]?.blockSize ?? node.getBoundingClientRect().height
        if (!Number.isFinite(box) || box <= 0) continue
        const prev = heights.get(id)
        // 亚像素抖动不算变化，否则流式时会一直重算前缀和
        if (prev === undefined || Math.abs(prev - box) > 0.5) {
          heights.set(id, box)
          changed = true
        }
      }
      if (changed && measureFrame.current === null) {
        // 一帧内可能有好几轮同时长高（多段流式），合并成一次重算
        measureFrame.current = window.requestAnimationFrame(() => {
          measureFrame.current = null
          setVersion((value) => value + 1)
        })
      }
    })
    container.querySelectorAll<HTMLElement>('[data-turn-id]').forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [enabled, start, end, ids.length])

  // 高度表更新后校正滚动位置
  const measureFrame = useRef<number | null>(null)
  const prevLayout = useRef<{
    offsets: number[]
    scrollTop: number
    stick: boolean
    length: number
  } | null>(null)
  useLayoutEffect(() => {
    if (!enabled) return
    const el = scrollRef.current
    if (!el) return
    const stick = isNearBottom(el.scrollTop, el.clientHeight, total, STICK_SLACK)
    const prev = prevLayout.current
    prevLayout.current = { offsets, scrollTop: el.scrollTop, stick, length: ids.length }
    if (!prev) return

    /*
     * 贴底跟随：只在「用户确实在底部」且「总高真的变了」时执行。
     *
     * 两个条件缺一不可：
     *   - 不看 stick 就滚，用户翻历史会被一路拽回底部；
     *   - 不看高度变化就滚，每次渲染都会写一次 scrollTop，「测量 → 滚底 →
     *     窗口变化 → 再测量」会自发循环，整页一直闪。
     */
    const prevTotal = prev.offsets[prev.offsets.length - 1] ?? 0
    if (stick && Math.abs(total - prevTotal) > 0.5) {
      el.scrollTop = el.scrollHeight
      // 自己写的滚动不算「用户滚过」，否则下一次校正会被误判跳过
      prevLayout.current.scrollTop = el.scrollTop
      return
    }

    // 用户在两帧之间自己滚过：以用户的位置为准，谁也不许拽回去
    if (Math.abs(prev.scrollTop - el.scrollTop) > 0.5) return

    // 轮次数量变了（翻页 / 新消息）交给 Chat 自己的补偿逻辑，这里别插手
    if (prev.length !== ids.length) return

    // 只是高度变了：保住视口顶部正在看的那一轮，别让人感觉画面被拽走
    const index = indexAt(prev.offsets, prev.scrollTop)
    const relative = prev.scrollTop - prev.offsets[index]
    const next = offsets[index]
    if (next !== undefined && Math.abs(next + relative - el.scrollTop) > 0.5) {
      el.scrollTop = next + relative
      prevLayout.current.scrollTop = el.scrollTop
    }
  }, [enabled, offsets, total, ids.length, scrollRef])

  if (!enabled) {
    return { start: 0, end: turns.length, topPad: 0, bottomPad: 0, total: 0, containerRef }
  }
  return { start, end, topPad: range.topPad, bottomPad: range.bottomPad, total, containerRef }
}
