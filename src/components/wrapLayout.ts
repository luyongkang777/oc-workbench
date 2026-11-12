/**
 * 换行模式的布局模型（纯函数，便于单测）。
 *
 * 虚拟滚动原本假设「一行 = 一个固定高度」。开启自动换行后这条假设不成立：
 * 一行源码可能占 1~N 个视觉行（N 取决于行长和容器宽度）。
 *
 * 这里不做全量高度表——100 万行的数组每加载一页都重建会卡滚动。改只记
 * 「比 1 行多出来的视觉行数」，靠前缀和 + 二分换算偏移：
 *
 *   rowOffset(i) = i + extra(i)        // i 之前所有行多出来的视觉行之和
 *
 * 已加载的行最多几千条（缓存 24 页 × 200 行），重建成本可忽略；
 * 未加载的行按 1 行计，等这一页真的读回来再自然校正。
 *
 * 与样式约定一致：`.code-line.wrap .code-text` 用 `white-space: pre-wrap` +
 * `word-break: break-all` + `tab-size: 4`，即「满了就在任意字符处断」，
 * 所以视觉行数可以用字符位宽精确算出来，不需要逐行上 DOM 量。
 */

import { LINE_HEIGHT, MAX_SCROLL_PX, OVERSCAN_LINES } from './codeWindow.ts'

/** 与 CSS 里 `.code-line.wrap .code-text { tab-size: 4 }` 保持一致。 */
export const TAB_SIZE = 4

export type WrapLayout = {
  lineCount: number
  /** 整份文件的视觉行总数（≥ lineCount）。 */
  totalRows: number
  /** 额外行 > 0 的行索引，升序。 */
  keys: Uint32Array
  /** keys[i] 及之前累计的额外行数。 */
  prefix: Float64Array
  /** 这一行占多少像素（查看器 19、diff 18）。 */
  lineHeight: number
  /** 大文件压缩比例；与 `scrollModel` 同一套语义。 */
  scale: number
  /** 滚动容器应有的内容高度。 */
  height: number
}

/**
 * 字符度量（px，布局坐标系）。宽字符不能按「2 个半角」算：
 * 实测 Cascadia Mono 12.5px 下半角 7.324px、中文 13px（1.775 倍），
 * 按 2 倍估会把中文行的行数算多，多出来的空行比折行本身更难看。
 */
export type WrapMetrics = { charWidth: number; wideWidth: number }

/** 宽字符（CJK / 全角 / Emoji）走 wideWidth，其余走 charWidth。 */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff)
  )
}

/**
 * 一行在 availPx 宽度下占几个视觉行。
 *
 * 逐字模拟浏览器的贪心折行：字符放不下就换行，换行后从头开始算（制表位也是从行首算）。
 * 这和 `word-break: break-all` 的断行规则一致——实测 320/600/900/1200px 四种宽度、
 * 英文长串 / 中文 / 混合 / Tab 缩进全部与真实渲染行数吻合。
 */
export function wrapRows(
  text: string,
  availPx: number,
  metrics: WrapMetrics,
  tabSize = TAB_SIZE,
): number {
  const charWidth = metrics.charWidth > 0 ? metrics.charWidth : 7.5
  const wideWidth = metrics.wideWidth > 0 ? metrics.wideWidth : charWidth * 2
  const avail = Math.max(availPx, charWidth)
  const tabStop = charWidth * tabSize

  let rows = 1
  let x = 0
  for (const ch of text) {
    let width: number
    if (ch === '\t') {
      // 制表位从当前视觉行行首起算
      const next = Math.ceil((x + 0.01) / tabStop) * tabStop
      width = Math.max(charWidth, next - x)
    } else {
      width = isWide(ch.codePointAt(0) ?? 0) ? wideWidth : charWidth
    }
    if (x > 0 && x + width > avail) {
      rows += 1
      x = 0
      if (ch === '\t') width = Math.min(tabStop, avail)
    }
    x += width
  }
  return rows
}

export function buildWrapLayout(
  lineCount: number,
  known: Iterable<readonly [number, number]>,
  lineHeight = LINE_HEIGHT,
): WrapLayout {
  const total = Math.max(0, Math.trunc(lineCount))
  // 同一行可能被不同页重复登记（换页、重试）。按最大值去重，避免高度被叠加。
  const extras = new Map<number, number>()
  for (const [line, rows] of known) {
    if (!Number.isFinite(line) || !Number.isFinite(rows)) continue
    const index = Math.trunc(line)
    if (index < 0 || index >= total) continue
    const extra = Math.max(0, Math.trunc(rows) - 1)
    if (extra === 0) continue
    if (extra > (extras.get(index) ?? 0)) extras.set(index, extra)
  }

  const keys = new Uint32Array(extras.size)
  const prefix = new Float64Array(extras.size)
  let acc = 0
  let cursor = 0
  for (const index of [...extras.keys()].sort((a, b) => a - b)) {
    acc += extras.get(index) ?? 0
    keys[cursor] = index
    prefix[cursor] = acc
    cursor += 1
  }

  const totalRows = total + acc
  // 与 scrollModel 同一套语义，只是行高可变（diff 面板是 18px）
  const content = Math.max(totalRows, 1) * lineHeight
  const height = Math.min(content, MAX_SCROLL_PX)
  return {
    lineCount: total,
    totalRows,
    keys,
    prefix,
    lineHeight,
    scale: height / content,
    height,
  }
}

/** 二分：最后一个 keys[i] < line 的下标；-1 表示没有。 */
function lastKeyBelow(keys: Uint32Array, line: number): number {
  let low = -1
  let high = keys.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (keys[mid] < line) low = mid
    else high = mid - 1
  }
  return low
}

/** line 之前累计的额外视觉行数。 */
export function extraBefore(layout: WrapLayout, line: number): number {
  if (layout.keys.length === 0) return 0
  const index = lastKeyBelow(layout.keys, line)
  return index < 0 ? 0 : layout.prefix[index]
}

/** 行（0 基）在整份内容里的起始视觉行。line >= lineCount 时返回总行数。 */
export function rowOffsetOf(layout: WrapLayout, line: number): number {
  if (line <= 0) return 0
  if (line >= layout.lineCount) return layout.totalRows
  return line + extraBefore(layout, line)
}

/** 视觉行 → 行（0 基）。rowOffsetOf 单调不减，可以二分行号。 */
export function lineAtRow(layout: WrapLayout, row: number): number {
  if (layout.lineCount <= 0) return 0
  const target = Math.max(0, row)
  let low = 0
  let high = layout.lineCount - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (rowOffsetOf(layout, mid) <= target) low = mid
    else high = mid - 1
  }
  return low
}

function perRow(layout: WrapLayout): number {
  return Math.max(layout.lineHeight * layout.scale, 0.001)
}

/** 视口首行（1 基），工具栏「第 N 行」用。 */
export function lineAtScrollTop(layout: WrapLayout, scrollTop: number): number {
  const row = Math.max(0, scrollTop) / perRow(layout)
  return Math.min(lineAtRow(layout, row) + 1, Math.max(layout.lineCount, 1))
}

/** 需要渲染的行区间（含 overscan）。 */
export function visibleRangeIn(
  layout: WrapLayout,
  scrollTop: number,
  viewportHeight: number,
): { first: number; last: number } {
  if (layout.lineCount <= 0) return { first: 0, last: 0 }
  const per = perRow(layout)
  const top = Math.max(0, scrollTop)
  const bottom = top + Math.max(viewportHeight, layout.lineHeight)
  const first = Math.max(0, lineAtRow(layout, top / per) - OVERSCAN_LINES)
  const last = Math.min(
    layout.lineCount - 1,
    lineAtRow(layout, bottom / per) + OVERSCAN_LINES,
  )
  return { first, last: Math.max(first, last) }
}

/** 跳转到 1 基行号时的 scrollTop（目标行贴到视口顶部，再夹到可滚动范围）。 */
export function scrollTopForLineIn(
  layout: WrapLayout,
  line: number,
  viewportHeight: number,
): number {
  const target = Math.min(Math.max(1, Math.trunc(line)), Math.max(layout.lineCount, 1))
  const top = rowOffsetOf(layout, target - 1) * perRow(layout)
  const maxTop = Math.max(0, layout.height - Math.max(viewportHeight, 0))
  return Math.min(maxTop, top)
}
