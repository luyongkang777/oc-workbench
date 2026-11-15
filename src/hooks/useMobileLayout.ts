import { useCallback, useEffect, useState } from 'react'

/**
 * 手机布局（窄视口单列）。
 *
 * 桌面是三栏并排（侧栏 / 编辑器 / 聊天）；视口窄到手机宽度时三栏挤成一团，
 * 聊天被挤到屏幕外，整个界面没法用。这里把「当前看哪一栏」抽成一个状态，
 * 由底部导航切换，同一时刻只显示一栏。
 *
 * 阈值只按宽度算，不按 UA：桌面把窗口拖窄到手机宽度时同样能用。
 */

export const MOBILE_MAX_WIDTH = 800
// 手机横屏（844x390 这类）宽度够宽但高度只剩三百多：
// 三栏会为了 240+520 的最小宽度把中间编辑器压没，所以矮屏也走单列。
export const MOBILE_MAX_HEIGHT = 520
const PANE_KEY = 'oc-workbench:mobile-pane'

export type MobilePane = 'files' | 'editor' | 'chat'

const PANES: readonly MobilePane[] = ['files', 'editor', 'chat']
const DEFAULT_PANE: MobilePane = 'chat'

export function isMobileWidth(width: number, height = Number.POSITIVE_INFINITY): boolean {
  if (!Number.isFinite(width) || width <= 0) return false
  if (width <= MOBILE_MAX_WIDTH) return true
  return Number.isFinite(height) && height > 0 && height <= MOBILE_MAX_HEIGHT
}

/** 同步判断当前视口：给「非组件」里决定拉多少数据用（如消息首屏条数）。 */
export function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false
  return isMobileWidth(window.innerWidth, window.innerHeight)
}

export function normalizePane(raw: string | null | undefined): MobilePane {
  return PANES.includes(raw as MobilePane) ? (raw as MobilePane) : DEFAULT_PANE
}

function readPane(): MobilePane {
  try {
    return normalizePane(window.localStorage.getItem(PANE_KEY))
  } catch {
    return DEFAULT_PANE
  }
}

function savePane(pane: MobilePane): void {
  try {
    window.localStorage.setItem(PANE_KEY, pane)
  } catch {
    /* 存不进去就算了，当次会话仍然生效 */
  }
}

export function useMobileLayout() {
  const [mobile, setWide] = useState(() => isMobileWidth(window.innerWidth, window.innerHeight))
  const [pane, setPaneState] = useState<MobilePane>(readPane)

  useEffect(() => {
    // matchMedia 比 resize 事件便宜，且拖拽缩放时不抖。
    const query = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px), (max-height: ${MOBILE_MAX_HEIGHT}px)`)
    const onChange = () => setWide(query.matches)
    onChange()
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const setPane = useCallback((next: MobilePane) => {
    const value = normalizePane(next)
    setPaneState(value)
    savePane(value)
  }, [])

  // 手机点开文件后自动跳到编辑器，否则点完似乎没反应。
  const showEditor = useCallback(() => setPane('editor'), [setPane])

  return { mobile, pane, setPane, showEditor }
}
