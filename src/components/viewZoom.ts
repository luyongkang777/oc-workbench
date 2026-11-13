/**
 * 查看区（中栏）自己的缩放：文件、图片、Markdown 预览共用一个比例。
 *
 * 为什么不用全局 `<html zoom>`：那是整块界面一起放大（工具栏、文件树、聊天都变大），
 * 用户想「把这行代码 / 这张图放大看」时不该连左栏右栏一起变。
 *
 * 为什么 zoom 加在**滚动容器**而不是内容层或 `<img>` 上（Edge 实测）：
 *   * 加在 `<img>` 上完全不生效（img 的 zoom 不改变它相对容器的占位）；
 *   * 加在内容层会让 scrollHeight 按比例变、而 scrollTop 仍按布局像素走，两者错位 → 滚动条位置乱跳；
 *   * 加在滚动容器上，clientWidth/clientHeight/scrollTop/scrollHeight/offsetHeight
 *     全都还是**布局像素**，虚拟滚动的 LINE_HEIGHT 与换行数学一律不用改；
 *     ResizeObserver 因为 zoom 变化会触发，视口重算自动跟上。
 *
 * 所以这里只维护比例本身的取值/取整/持久化，DOM 那边给容器塞 style.zoom 即可。
 */

const ZOOM_KEY = 'oc-workbench:view-zoom'

/**
 * 两套比例分开记：代码/文档和图片想要的大小通常不一样。
 * 同一个档位用在两处会出现「把代码放到 150% 后打开图片，图片也不是适应窗口了」这种别扭。
 */
export type ZoomKind = 'text' | 'image'

/** 缩放档位范围：再小看不清字，再大单屏只剩几个字。 */
export const VIEW_ZOOM = { min: 0.5, max: 4, def: 1 }

/** 每档步进。0.1 在手感上够细，百分比显示又不会出现 133% 这种怪数字。 */
export const ZOOM_STEP = 0.1

/** 夹到合法区间，并消掉浮点误差（0.1 累加会得到 1.3000000000000003）。 */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return VIEW_ZOOM.def
  const clamped = Math.min(VIEW_ZOOM.max, Math.max(VIEW_ZOOM.min, value))
  return Math.round(clamped * 100) / 100
}

/** 放大/缩小一档。到边界就停在边界，不绕圈。 */
export function stepZoom(value: number, delta: number): number {
  return clampZoom(value + delta * ZOOM_STEP)
}

/** 百分比文案（50% / 125% / 400%）。 */
export function zoomLabel(value: number): string {
  return `${Math.round(clampZoom(value) * 100)}%`
}

function readNumber(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw == null) return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  } catch {
    // localStorage 被禁用：当次会话仍可用，只是记不住
    return null
  }
}

function saveNumber(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    /* 存不进去不影响使用 */
  }
}

/**
 * 读缩放偏好：按项目根各记一份，新项目沿用最近一次的全局值。
 * 和换行偏好（wrapPrefs.ts）同一套规则，用户不必每个项目重新调。
 */
export function readViewZoom(root: string, kind: ZoomKind = 'text'): number {
  const own = readNumber(`${ZOOM_KEY}:${kind}:${root}`)
  if (own !== null) return clampZoom(own)
  const shared = readNumber(`${ZOOM_KEY}:${kind}`)
  if (shared !== null) return clampZoom(shared)
  // 老版本只存过一套（没有 kind 段）：text 沿用它，image 从 100% 起
  if (kind === 'text') {
    const legacy = readNumber(`${ZOOM_KEY}:${root}`) ?? readNumber(ZOOM_KEY)
    if (legacy !== null) return clampZoom(legacy)
  }
  return VIEW_ZOOM.def
}

export function writeViewZoom(root: string, value: number, kind: ZoomKind = 'text'): void {
  const next = clampZoom(value)
  saveNumber(`${ZOOM_KEY}:${kind}:${root}`, next)
  saveNumber(`${ZOOM_KEY}:${kind}`, next)
}

/**
 * Ctrl/⌘ + 滚轮 → 新比例。
 *
 * 用 deltaY 的**符号**而不是幅度：触控板一次滑动会连发几十个 0.1 的 deltaY，
 * 按幅度累加会一滑就冲到底。滚轮一格走一档才是能用的手感。
 */
export function zoomFromWheel(value: number, deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return clampZoom(value)
  return stepZoom(value, deltaY < 0 ? 1 : -1)
}
