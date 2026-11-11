import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 界面布局：三栏宽度 + 整体缩放。
 * 两个都落 localStorage，刷新后保持。
 */

const SIDE_KEY = 'oc-workbench:side-w'
const CHAT_KEY = 'oc-workbench:chat-w'
const SCALE_KEY = 'oc-workbench:scale'

export const SIDE_W = { min: 180, max: 380, def: 232 }
export const CHAT_W = { min: 360, max: 820, def: 500 }
export const SCALE = { min: 0.8, max: 1.6, def: 1 }

const HINT_MS = 1600

function readNumber(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key)
    const n = raw == null ? Number.NaN : Number(raw)
    return Number.isFinite(n) ? n : fallback
  } catch {
    // localStorage 被禁用时退回默认值，不能让界面起不来
    return fallback
  }
}

function saveNumber(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    /* 存不进去就算了，当次会话仍然生效 */
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

const round100 = (value: number) => Math.round(value * 100) / 100

export function useUiLayout() {
  const [sideW, setSideWState] = useState(() => clamp(readNumber(SIDE_KEY, SIDE_W.def), SIDE_W.min, SIDE_W.max))
  const [chatW, setChatWState] = useState(() => clamp(readNumber(CHAT_KEY, CHAT_W.def), CHAT_W.min, CHAT_W.max))
  const [scale, setScaleState] = useState(() => round100(clamp(readNumber(SCALE_KEY, SCALE.def), SCALE.min, SCALE.max)))
  // 缩放时右下角短暂浮现的比例；null 表示不显示
  const [scaleHint, setScaleHint] = useState<string | null>(null)

  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 滚轮连续触发时要在同步回调里拿到「上一次的值」，state 更新是异步的
  const scaleRef = useRef(scale)

  const setSideW = useCallback((value: number) => {
    const next = Math.round(clamp(value, SIDE_W.min, SIDE_W.max))
    setSideWState(next)
    saveNumber(SIDE_KEY, next)
  }, [])

  const setChatW = useCallback((value: number) => {
    const next = Math.round(clamp(value, CHAT_W.min, CHAT_W.max))
    setChatWState(next)
    saveNumber(CHAT_KEY, next)
  }, [])

  const showScaleHint = useCallback((value: number) => {
    setScaleHint(`${Math.round(value * 100)}%`)
    if (hintTimer.current) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => setScaleHint(null), HINT_MS)
  }, [])

  const applyScale = useCallback(
    (value: number) => {
      const next = round100(clamp(value, SCALE.min, SCALE.max))
      if (next === scaleRef.current) return
      scaleRef.current = next
      setScaleState(next)
      saveNumber(SCALE_KEY, next)
      showScaleHint(next)
    },
    [showScaleHint],
  )

  const setScale = useCallback((value: number) => applyScale(value), [applyScale])

  const resetSizes = useCallback(() => {
    setSideW(SIDE_W.def)
    setChatW(CHAT_W.def)
  }, [setSideW, setChatW])

  // 一键复位：三栏回默认 + 缩放回 100%。
  // 即使当前已经是 100% 也要弹一次提示，否则按下去像没反应。
  const resetLayout = useCallback(() => {
    setSideW(SIDE_W.def)
    setChatW(CHAT_W.def)
    const next = SCALE.def
    scaleRef.current = next
    setScaleState(next)
    saveNumber(SCALE_KEY, next)
    setScaleHint(`${Math.round(next * 100)}%`)
    if (hintTimer.current) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => setScaleHint(null), HINT_MS)
  }, [setSideW, setChatW])

  useEffect(() => {
    scaleRef.current = scale
  }, [scale])

  // zoom 是布局级缩放：字号、行高、圆角、内边距、三栏宽度一起等比变，
  // 不用把几百个 px 改成 rem。Chromium 系直接支持。
  useEffect(() => {
    document.documentElement.style.zoom = String(scale)
  }, [scale])

  // Ctrl / Cmd + 滚轮。普通滚轮不拦，终端和代码区的滚动不受影响。
  useEffect(() => {
    function onWheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const step = event.deltaY < 0 ? 0.1 : -0.1
      applyScale(scaleRef.current + step)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [applyScale])

  // Ctrl / Cmd + 0 复位。浏览器自带的「重置页面缩放」也被一并挡掉，
  // 否则会变成两套缩放互相打架。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey && !event.metaKey) return
      if (event.key !== '0' && event.code !== 'Digit0' && event.code !== 'Numpad0') return
      event.preventDefault()
      resetLayout()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [resetLayout])

  useEffect(() => {
    return () => {
      if (hintTimer.current) clearTimeout(hintTimer.current)
    }
  }, [])

  return { sideW, chatW, scale, scaleHint, setSideW, setChatW, setScale, resetSizes, resetLayout }
}
