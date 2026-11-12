/**
 * 主题偏好：跟随系统 / 强制暗色 / 强制浅白。
 *
 * 存的是「偏好」，不是「结果」：<html data-theme> 永远写解析后的值，
 * 这样 CSS 不需要知道「系统」这一档，media query 变化时只改 data-theme 即可。
 */

export type ThemePref = 'system' | 'dark' | 'light'
export type ResolvedTheme = 'dark' | 'light'

/** 点击顶栏按钮时轮换：跟随系统 → 暗 → 浅 → 跟随系统。 */
const CYCLE: ThemePref[] = ['system', 'dark', 'light']

export const DEFAULT_THEME_PREF: ThemePref = 'system'

/** localStorage 里可能是旧版本写入的 'dark' / 'light'，也可能被手改成脏值。 */
export function parseThemePref(raw: string | null): ThemePref {
  return raw === 'dark' || raw === 'light' || raw === 'system' ? raw : DEFAULT_THEME_PREF
}

/** 偏好 + 系统当前是否深色 → 实际该用的主题。 */
export function resolveTheme(pref: ThemePref, prefersDark: boolean): ResolvedTheme {
  if (pref === 'system') return prefersDark ? 'dark' : 'light'
  return pref
}

export function nextThemePref(pref: ThemePref): ThemePref {
  const index = CYCLE.indexOf(pref)
  return CYCLE[(index + 1) % CYCLE.length] ?? DEFAULT_THEME_PREF
}

/** 顶栏图标的悬浮提示：说清「现在是什么」，以及「点一下会变成什么」。 */
export function themeTitle(pref: ThemePref, resolved: ResolvedTheme): string {
  if (pref === 'system') return `跟随系统（当前${resolved === 'dark' ? '暗色' : '浅白'}）· 点击切到暗色`
  if (pref === 'dark') return '暗色主题 · 点击切到浅白'
  return '浅白主题 · 点击切到跟随系统'
}

/** 切换后浮层里的一行短提示。 */
export function themeLabel(pref: ThemePref, resolved: ResolvedTheme): string {
  if (pref === 'system') return `跟随系统（当前${resolved === 'dark' ? '暗色' : '浅白'}）`
  return pref === 'dark' ? '暗色' : '浅白'
}

/** 顶栏图标：跟随系统用显示器，强制态用太阳/月亮。 */
export function themeIcon(pref: ThemePref, resolved: ResolvedTheme): 'monitor' | 'sun' | 'moon' {
  if (pref === 'system') return 'monitor'
  return resolved === 'light' ? 'sun' : 'moon'
}
