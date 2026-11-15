import { useEffect, useState } from 'react'
import {
  parseThemePref,
  prefersDarkScheme,
  resolveTheme,
  type ResolvedTheme,
  type ThemePref,
} from '../components/theme'

const THEME_KEY = 'oc-workbench:theme'

/**
 * 主题偏好（跟随系统 / 暗 / 浅）与解析结果。
 *
 * 存的是**偏好**不是结果：系统换色时跟随模式会自动跟上，不用用户再点一次。
 * 解析后的主题写到 `<html data-theme>`，CSS 的 `:root[data-theme='light']` 据此整体切换。
 */
export function useTheme() {
  const [themePref, setThemePref] = useState<ThemePref>(() => {
    try {
      return parseThemePref(window.localStorage.getItem(THEME_KEY))
    } catch {
      // localStorage 被禁用时跟随系统
      return 'system'
    }
  })
  // 系统当前是否深色：由 prefers-color-scheme 驱动，切系统主题时实时更新
  const [systemDark, setSystemDark] = useState(() => prefersDarkScheme())

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    setSystemDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const theme: ResolvedTheme = resolveTheme(themePref, systemDark)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.themePref = themePref
    try {
      window.localStorage.setItem(THEME_KEY, themePref)
    } catch {
      // 存储不可用只影响下次启动的恢复，不影响本次
    }
  }, [theme, themePref])

  return { themePref, setThemePref, theme }
}
