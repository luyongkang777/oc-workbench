/**
 * 轮次窗口计算（纯函数，不碰 React / DOM）。
 *
 * 会话历史几百轮时，全量挂载的代价不是「渲染慢一点」，而是每个 turn 的
 * Markdown 都要解析一遍、每个气泡都要参与布局与绘制。窗口化只挂载视口
 * 附近的几轮，屏幕外用两个 spacer 撑住高度，滚动条长度不变。
 *
 * 高度未知时用估算值（和 contain-intrinsic-size 保持同一个数），测量到
 * 真实高度后自动替换 —— 所以窗口计算必须每次重算前缀和，不能缓存死。
 */

export type WindowRange = {
  /** 从第几轮开始挂载（含） */
  start: number
  /** 到第几轮结束（不含） */
  end: number
  topPad: number
  bottomPad: number
}

/** 前面累计高度：offsets[i] = 第 i 轮开始处的 y 坐标，offsets[n] = 总高。 */
export function buildOffsets(
  ids: readonly string[],
  heights: ReadonlyMap<string, number>,
  estimate: number,
): number[] {
  const offsets = new Array<number>(ids.length + 1)
  offsets[0] = 0
  for (let i = 0; i < ids.length; i += 1) {
    const measured = heights.get(ids[i])
    const height = measured !== undefined && measured > 0 ? measured : estimate
    offsets[i + 1] = offsets[i] + height
  }
  return offsets
}

/**
 * 第一个「底边超过 top」的轮次下标。
 *
 * 二分而不是线性扫：历史几千轮时每次滚动都要算，线性会变成每帧 O(n)。
 */
export function indexAt(offsets: readonly number[], top: number): number {
  const count = offsets.length - 1
  if (count <= 0) return 0
  if (top <= 0) return 0
  if (top >= offsets[count]) return count - 1

  let low = 0
  let high = count - 1
  while (low < high) {
    const mid = (low + high) >> 1
    // 第 mid 轮的底边在 offsets[mid + 1]
    if (offsets[mid + 1] > top) high = mid
    else low = mid + 1
  }
  return low
}

/**
 * 当前视口需要挂载的区间。
 *
 * overscan 是视口上下各多挂几轮：滚动时下一屏已经准备好，不会先看到空白。
 * 值别给大 —— 每一轮都是一次完整 Markdown 解析，overscan 3 已经足够。
 */
export function computeWindow(
  offsets: readonly number[],
  viewportTop: number,
  viewportHeight: number,
  overscan: number,
): WindowRange {
  const count = offsets.length - 1
  if (count <= 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0 }

  const top = Math.max(0, viewportTop)
  const bottom = top + Math.max(0, viewportHeight)
  const first = Math.max(0, indexAt(offsets, top) - overscan)
  const lastVisible = indexAt(offsets, bottom)
  const end = Math.min(count, lastVisible + 1 + overscan)
  const total = offsets[count]

  return {
    start: first,
    end: Math.max(first, end),
    topPad: offsets[first],
    bottomPad: Math.max(0, total - offsets[Math.max(first, end)]),
  }
}

/** 视口是否贴着底部（留一点余量，避免亚像素误差让跟随失效）。 */
export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  total: number,
  slack = 80,
): boolean {
  return total - scrollTop - clientHeight <= slack
}
