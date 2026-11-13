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
  /**
   * 用户是不是还在贴着底部看。
   *
   * 不能用布局阶段现算的 total 判断：高度还在测量，total 会从估算的 260px
   * 一路长到实测值；拿新 total 和旧 scrollTop 一比就判成「不在底部」，
   * 于是内容长高一屏，视口就再也不跟了。这里只在真实滚动事件里按位置差更新。
   */
  const stickRef = useRef(true)
  /** 上一次同步看到的 scrollTop：判断这次「位置真的动了」，还是只是内容长高。 */
  const lastTopRef = useRef<number | null>(null)

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
    const gap = el.scrollHeight - top - height
    const prevTop = lastTopRef.current
    lastTopRef.current = top

    /*
     * 贴底状态怎么更新。
     *
     * 三条规则，缺一条都会让「切回会话停在半路」复发：
     *   - 已经在底部（留 12px 亚像素余量）→ 贴底，不管是谁滚的；
     *   - 第一次同步不判（prevTop 为 null）：这时 scrollTop 还是浏览器给的初始值，
     *     而列表可能已经按估算高度铺开了几万像素，一判就是「不在底部」，
     *     之后上层的「回到底部」永远被压住；
     *   - 位置真的移动过才改：内容长高会让 gap 变大但 scrollTop 不动，
     *     那不是用户滚动，不能因此清掉贴底。
     */
    if (gap <= STICK_SLACK) {
      stickRef.current = true
    } else if (prevTop !== null && Math.abs(top - prevTop) > 0.5) {
      stickRef.current = false
    }
    setViewport((prev) => (prev.top === top && prev.height === height ? prev : { top, height }))
  }, [scrollRef])

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(sync)
  }, [sync])

  // 滚动 + 容器尺寸变化。
  //
  // enabled 必须进依赖：短会话时窗口化是关的，effect 第一遍就 return 了；等会话
  // 长过阈值、enabled 变 true，如果依赖不变这个 effect 永远不会重跑，scroll 监听
  // 和 sync 全都没挂上，viewport 永远停在 {0,0}，窗口就永远钉在列表最顶上。
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
  }, [enabled, scrollRef, schedule, sync])

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
    length: number
  } | null>(null)
  useLayoutEffect(() => {
    if (!enabled) return
    const el = scrollRef.current
    if (!el) return
    const stick = stickRef.current
    const prev = prevLayout.current
    const write = (value: number) => {
      el.scrollTop = value
      if (prevLayout.current) prevLayout.current.scrollTop = el.scrollTop
      lastTopRef.current = el.scrollTop
    }
    prevLayout.current = { offsets, scrollTop: el.scrollTop, length: ids.length }
    if (!prev) {
      sync()
      return
    }

    /*
     * 贴底：用户还在底部，内容怎么变都保持贴在最新一条。
     *
     * 判断条件是「现在不在底部」而不是「总高变了」：高度还在测量时，窗口会先按
     * 260px 的估算值挂载，真实高度落定后总高动辄翻几倍；只看总高变化的话，中间
     * 任何一次补偿都会把人留在半路。写之前先比对位置，已经在底部就不写，因此不会
     * 「测量 → 滚底 → 窗口变化 → 再测量」地自激闪屏。
     */
    if (stick) {
      const max = Math.max(0, el.scrollHeight - el.clientHeight)
      if (Math.abs(el.scrollTop - max) > 1) write(max)
      // 窗口锚点立刻跟上：spacer 动辄几万像素，锚点留在旧位置就会把整段内容
      // 渲染到视口之外，屏幕上只剩 spacer —— 这正是「切回旧会话一片空白」。
      sync()
      return
    }

    /*
     * 用户在翻历史：保住视口顶部正在看的那一轮，别让人感觉画面被拽走。
     * 轮次数量变了（切会话 / 翻页 / 新消息）就交给上层自己的补偿逻辑，这里只对锚点。
     */
    if (prev.length === ids.length && Math.abs(prev.scrollTop - el.scrollTop) <= 0.5) {
      const index = indexAt(prev.offsets, prev.scrollTop)
      const relative = prev.scrollTop - prev.offsets[index]
      const next = offsets[index]
      if (next !== undefined && Math.abs(next + relative - el.scrollTop) > 0.5) {
        write(next + relative)
      }
    }
    sync()
  }, [enabled, offsets, ids.length, scrollRef, sync])

  if (!enabled) {
    return { start: 0, end: turns.length, topPad: 0, bottomPad: 0, total: 0, containerRef }
  }
  return { start, end, topPad: range.topPad, bottomPad: range.bottomPad, total, containerRef }
}
