import { useCallback, useEffect, useRef, useState } from 'react'
import {
  VIEW_ZOOM,
  clampZoom,
  readViewZoom,
  stepZoom,
  writeViewZoom,
  zoomFromWheel,
  type ZoomKind,
} from '../components/viewZoom'

/**
 * 查看区缩放：一个比例 + 三种入口（工具栏按钮 / Ctrl+滚轮 / Ctrl+加减）。
 *
 * 比例按项目根记忆；切项目读回该项目自己的值。
 * 只负责「值」与输入，DOM 那边把 `zoom` 塞给滚动容器即可（见 viewZoom.ts 的注释）。
 */
export function useViewZoom(root: string, kind: ZoomKind = 'text') {
  const [zoom, setZoomState] = useState(() => readViewZoom(root, kind))
  // 滚轮连发时要拿到「上一次的值」：setState 是异步的，不能靠 zoom 变量
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  // 切项目 / 切文件类型（文本 ↔ 图片）：读回对应的偏好
  useEffect(() => {
    const next = readViewZoom(root, kind)
    zoomRef.current = next
    setZoomState(next)
  }, [root, kind])

  const apply = useCallback(
    (next: number) => {
      const value = clampZoom(next)
      if (value === zoomRef.current) return
      zoomRef.current = value
      setZoomState(value)
      writeViewZoom(root, value, kind)
    },
    [root, kind],
  )

  const zoomIn = useCallback(() => apply(stepZoom(zoomRef.current, 1)), [apply])
  const zoomOut = useCallback(() => apply(stepZoom(zoomRef.current, -1)), [apply])
  const setZoom = useCallback((value: number) => apply(value), [apply])
  /** 回到 100%：按了总要有反应，即使当前已经是 100%。 */
  const resetZoom = useCallback(() => apply(VIEW_ZOOM.def), [apply])

  return { zoom, setZoom, zoomIn, zoomOut, resetZoom }
}

/**
 * Ctrl/⌘ + 滚轮：只在鼠标位于 `attachRef` 指向的元素内时生效。
 *
 * 为什么不挂在 window 上：全局那条已经有（`useUiLayout` 缩放整个界面），
 * 两条都拦会互抢。这里用 capture + 命中判断，保证「鼠标在代码区就缩放代码区」，
 * 别的地方仍归全局缩放管。
 */
export function useZoomWheel(
  attachRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  onWheel: (deltaY: number) => void,
) {
  const handlerRef = useRef(onWheel)
  handlerRef.current = onWheel

  useEffect(() => {
    if (!enabled) return
    function onWheelEvent(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return
      const host = attachRef.current
      if (!host) return
      // 事件目标是宿主内部的节点才算「鼠标在查看区」
      if (event.target instanceof Node && !host.contains(event.target)) return
      event.preventDefault()
      // 阻止冒泡到 window 的全局缩放（那里也监听 wheel）
      event.stopPropagation()
      handlerRef.current(event.deltaY)
    }
    // capture 抢在 window 那层之前，才能拦住全局缩放
    window.addEventListener('wheel', onWheelEvent, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', onWheelEvent, { capture: true })
  }, [attachRef, enabled])
}
/**
 * Ctrl/⌘ + `=` / `-` / `0`：只用键盘也能缩放。
 *
 * 分级处理，为了既好用又不抢全局：
 *   * `=` / `-`：全局生效（只要查看区存在）。刚点完文件树就按也能用，
 *     否则用户会以为快捷键坏了。
 *   * `0`：只在焦点在查看区里时生效。全局那个 Ctrl+0 是「重置整个布局」，
 *     不区分焦点地抢掉它，用户按了会以为那个功能没了。
 */
export function useZoomKeys(
  attachRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  onZoomIn: () => void,
  onZoomOut: () => void,
  onReset: () => void,
) {
  const refs = useRef({ onZoomIn, onZoomOut, onReset })
  refs.current = { onZoomIn, onZoomOut, onReset }

  useEffect(() => {
    if (!enabled) return
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey && !event.metaKey) return
      if (event.altKey || event.shiftKey) return
      // 查看区没挂上（还没打开文件）就不插手
      if (!attachRef.current) return

      const key = event.key
      const code = event.code
      if (key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd') {
        event.preventDefault()
        refs.current.onZoomIn()
        return
      }
      if (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract') {
        event.preventDefault()
        refs.current.onZoomOut()
        return
      }
      if (key === '0' || code === 'Digit0' || code === 'Numpad0') {
        // 焦点不在查看区：让给全局的「重置布局」
        const active = document.activeElement
        if (!active || !attachRef.current.contains(active)) return
        event.preventDefault()
        // capture 阶段就吃掉，避免冒泡到 useUiLayout 的全局 Ctrl+0 顺带重置整个布局
        event.stopPropagation()
        refs.current.onReset()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [attachRef, enabled])
}
