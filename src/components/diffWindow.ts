/**
 * diff 虚拟滚动的纯计算（不碰 React，便于单测）。
 *
 * 关键约定：`DIFF_LINE_HEIGHT` 必须和 `styles/diff.css` 里 `.diff-body` 的
 * `line-height` 一致（18px），且 `.diff-line` 不能有纵向 padding——否则
 * 滚动位置和实际行会错位。
 */

/** 与 `.diff-body` 的 line-height 保持一致。 */
export const DIFF_LINE_HEIGHT = 18
/** 视口上下各多渲染多少行：滚动时不至于看到空白。 */
export const DIFF_OVERSCAN = 40

export type DiffWindow = {
  /** 第一行（含） */
  first: number
  /** 最后一行（不含） */
  last: number
  /** 顶部占位高度：first * 行高 */
  offset: number
  /** 整个文档高度：total * 行高 */
  height: number
}

/** 只算视口内要渲染的行区间；空 patch 返回全 0。 */
export function diffWindow(totalLines: number, scrollTop: number, viewportHeight: number): DiffWindow {
  const total = Math.max(0, Math.trunc(totalLines))
  const height = total * DIFF_LINE_HEIGHT
  if (total === 0) return { first: 0, last: 0, offset: 0, height: 0 }

  const clamped = Math.max(0, Math.min(scrollTop, Math.max(0, height - 1)))
  const firstVisible = Math.floor(clamped / DIFF_LINE_HEIGHT)
  const visibleCount =
    Math.ceil(Math.max(viewportHeight, DIFF_LINE_HEIGHT) / DIFF_LINE_HEIGHT) + 1
  const first = Math.max(0, firstVisible - DIFF_OVERSCAN)
  const last = Math.min(total, firstVisible + visibleCount + DIFF_OVERSCAN)
  return { first, last, offset: first * DIFF_LINE_HEIGHT, height }
}
