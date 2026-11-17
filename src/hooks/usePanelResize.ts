import { useCallback, useRef } from 'react'
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from 'react'
import { TERM_H } from './useUiLayout'

/**
 * 面板拖拽：左右两栏宽度 + 停靠终端高度。
 *
 * 从 App.tsx 里抽出来的（那边已经 390 行）。两个方向的手感要一致：
 * - 用「渲染尺寸 / 逻辑尺寸」换算，抵消 Ctrl+滚轮 zoom
 * - 320ms 内连按两次 = 双击复位
 */

type Options = {
  sideW: number
  chatW: number
  termH: number
  setSideW: (value: number) => void
  setChatW: (value: number) => void
  setTermH: (value: number) => void
  resetSizes: () => void
  mainRef: MutableRefObject<HTMLDivElement | null>
}

/** 拖动时每帧调用，统一在这里加/去 body 上的光标锁。 */
function lockCursor(className: string, onMove: (event: PointerEvent) => void, onDone: () => void) {
  document.body.classList.add(className)
  const finish = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    document.body.classList.remove(className)
    onDone()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
}

export function usePanelResize(opts: Options) {
  const { sideW, chatW, termH, setSideW, setChatW, setTermH, resetSizes, mainRef } = opts
  const lastGrabRef = useRef(0)
  const lastTermGrabRef = useRef(0)

  const beginResize = useCallback(
    (which: 'side' | 'chat') => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return

      const now = performance.now()
      const isDouble = lastGrabRef.current > 0 && now - lastGrabRef.current < 320
      lastGrabRef.current = isDouble ? 0 : now
      if (isDouble) {
        resetSizes()
        return
      }

      event.preventDefault()
      const main = mainRef.current
      if (!main) return

      const target = main.querySelector(which === 'side' ? '.sidebar' : '.chat-pane')
      const base = which === 'side' ? sideW : chatW
      const rendered = target?.getBoundingClientRect().width ?? base
      const ratio = base > 0 && rendered > 0 ? rendered / base : 1
      const startX = event.clientX

      lockCursor(
        'resizing',
        (moveEvent) => {
          const delta = (moveEvent.clientX - startX) / ratio
          // 左侧分隔条往右拖 = 变宽；右侧分隔条往右拖 = 聊天变窄
          if (which === 'side') setSideW(base + delta)
          else setChatW(base - delta)
        },
        () => undefined,
      )
    },
    [sideW, chatW, setSideW, setChatW, resetSizes, mainRef],
  )

  const beginTerminalResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return

      const now = performance.now()
      const isDouble = lastTermGrabRef.current > 0 && now - lastTermGrabRef.current < 320
      lastTermGrabRef.current = isDouble ? 0 : now
      if (isDouble) {
        setTermH(TERM_H.def)
        return
      }

      event.preventDefault()
      const rendered = mainRef.current?.querySelector('.terminal')?.getBoundingClientRect().height ?? 0
      const zoom = Number(window.getComputedStyle(document.documentElement).zoom)
      // zoom 拿不到数值（旧引擎返回 normal）时退回「渲染高 / 逻辑高」
      const ratio =
        Number.isFinite(zoom) && zoom > 0
          ? zoom
          : rendered > 0 && termH > 0
            ? rendered / termH
            : 1
      // 起点取实际渲染高：存的 termH 可能大于 max-height 允许值，直接用会先吃掉差值
      const base = rendered > 0 ? rendered / ratio : termH
      const startY = event.clientY

      lockCursor(
        'resizing-row',
        (moveEvent) => {
          const delta = (startY - moveEvent.clientY) / ratio
          setTermH(base + delta)
        },
        () => undefined,
      )
    },
    [termH, setTermH, mainRef],
  )

  return { beginResize, beginTerminalResize }
}
