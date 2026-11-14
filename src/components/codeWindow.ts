/**
 * 编辑器虚拟滚动的纯计算逻辑（与 React 无关，便于单测）。
 *
 * 关键约定：[`LINE_HEIGHT`] 必须和 `styles/editor.css` 里 `.code-line` 的行高一致，
 * 且 `.code-block` 不能再有纵向 padding（否则滚动位置会恒差几像素）。
 */

/** 与 `.code-line` 的 line-height 保持一致。 */
export const LINE_HEIGHT = 19
/** 一页读多少行：太小请求多，太大单页渲染/内存压力大。 */
export const WINDOW_LINES = 200
/** 视口上下各多渲染多少行，滚动时不至于看到空白。 */
export const OVERSCAN_LINES = 60
/** 同时缓存多少页，超出就从离视口最远的开始丢。 */
export const MAX_PAGES = 24
/**
 * 滚动容器高度上限。Chromium 的滚动高度上限约 3300 万 px（行高 19 → 约 176 万行），
 * 超过会「滚到底也到不了文件末尾」；这里压到 1600 万并做比例映射。
 */
export const MAX_SCROLL_PX = 16_000_000

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])
/** 能直接渲染成页面的格式：默认走「预览」，可切回源码。 */
const HTML_EXT = new Set(['html', 'htm', 'xhtml', 'shtml'])

export function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXT.has(extOf(path))
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.has(extOf(path))
}

/** HTML 类文件：用 iframe 渲染预览（Markdown 走 react-markdown，两者互斥）。 */
export function isHtmlPath(path: string): boolean {
  return HTML_EXT.has(extOf(path))
}

/** 总高度与「像素 → 行」的比例；行数特别多时 scale < 1。 */
export function scrollModel(totalLines: number): { height: number; scale: number } {
  const content = Math.max(totalLines, 1) * LINE_HEIGHT
  if (content <= MAX_SCROLL_PX) return { height: content, scale: 1 }
  return { height: MAX_SCROLL_PX, scale: MAX_SCROLL_PX / content }
}

/** 需要渲染的行区间（含 overscan），已按总行数裁剪。 */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  totalLines: number,
  scale = 1,
): { first: number; last: number } {
  const perLine = Math.max(LINE_HEIGHT * scale, 0.001)
  const total = Math.max(totalLines, 1)
  const first = Math.min(
    Math.max(0, Math.floor(scrollTop / perLine) - OVERSCAN_LINES),
    total - 1,
  )
  const last = Math.min(
    total - 1,
    Math.ceil((scrollTop + Math.max(viewportHeight, LINE_HEIGHT)) / perLine) + OVERSCAN_LINES,
  )
  return { first, last: Math.max(first, last) }
}

/** scrollTop 对应的视口首行（1 基），用于工具栏「第 N 行」。 */
export function lineAtScrollTop(scrollTop: number, totalLines: number, scale = 1): number {
  const total = Math.max(totalLines, 1)
  const perLine = Math.max(LINE_HEIGHT * scale, 0.001)
  const line = Math.floor(Math.max(0, scrollTop) / perLine) + 1
  return Math.min(Math.max(1, line), total)
}

/**
 * 跳转到 1 基行号时的 scrollTop：目标行放到视口顶部，再夹到可滚动范围。
 * 行数超过滚动上限时同样用 scale 映射后的坐标。
 */
export function scrollTopForLine(
  line: number,
  totalLines: number,
  viewportHeight: number,
  scale = 1,
): number {
  const total = Math.max(totalLines, 1)
  const target = Math.min(Math.max(1, Math.trunc(line)), total)
  const height = total * LINE_HEIGHT * scale
  const maxTop = Math.max(0, height - Math.max(viewportHeight, 0))
  return Math.min(maxTop, (target - 1) * LINE_HEIGHT * scale)
}

/** 搜索命中的环形下标（上一个/下一个自动回绕）。 */
export function cycleIndex(current: number, total: number, delta: number): number {
  if (total <= 0) return -1
  return (current + delta + total) % total
}

/**
 * 把一行文本按关键词切成普通/命中片段，供搜索结果高亮。
 * 大小写不敏感；若 lower/upper 长度不一致（少见 Unicode）就放弃高亮，只显示原文。
 */
export function splitMatches(
  text: string,
  query: string,
): { text: string; match: boolean }[] {
  const needle = query.toLowerCase()
  if (!needle) return [{ text, match: false }]
  const hay = text.toLowerCase()
  if (hay.length !== text.length) return [{ text, match: false }]

  const parts: { text: string; match: boolean }[] = []
  let cursor = 0
  for (;;) {
    const hit = hay.indexOf(needle, cursor)
    if (hit < 0) {
      if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false })
      break
    }
    if (hit > cursor) parts.push({ text: text.slice(cursor, hit), match: false })
    parts.push({ text: text.slice(hit, hit + needle.length), match: true })
    cursor = hit + needle.length
  }
  return parts.length ? parts : [{ text, match: false }]
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
