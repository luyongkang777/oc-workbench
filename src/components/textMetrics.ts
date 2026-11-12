/**
 * 等宽字体的字符度量：换行行数要靠「一行能放多宽的字符」算出来。
 *
 * 为什么用 canvas 量而不是 DOM 量：
 *   界面整体缩放走的是 `<html style="zoom">`，getBoundingClientRect 返回的是
 *   缩放后的视觉像素，而 clientWidth / 计算后的 font-size 都是未缩放的布局像素。
 *   混用会得到两三倍的误差。canvas 的 measureText 只吃字号字符串，不吃 zoom，
 *   和 clientWidth 同一套坐标系，最稳。
 *
 * 宽字符要单独量：等宽字体里中文常见 1.7~2 倍半角，不能假设正好 2 倍。
 */

export type CodeMetrics = {
  /** 半角字符宽（px，布局坐标系）。 */
  charWidth: number
  /** 宽字符（CJK / 全角）宽（px）。 */
  wideWidth: number
}

const FALLBACK: CodeMetrics = { charWidth: 7.5, wideWidth: 15 }

let canvas: HTMLCanvasElement | null = null

export function measureCodeMetrics(el: HTMLElement | null): CodeMetrics {
  if (!el || typeof document === 'undefined') return FALLBACK
  const style = window.getComputedStyle(el)
  const fontSize = Number.parseFloat(style.fontSize)
  if (!Number.isFinite(fontSize) || fontSize <= 0) return FALLBACK

  canvas ??= document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return FALLBACK

  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`

  // 用 40 个字符取平均：单字符的 hinting 取整在小字号下误差能到 10%
  const sample = 40
  const narrow = ctx.measureText('M'.repeat(sample)).width / sample
  const wide = ctx.measureText('中'.repeat(sample)).width / sample
  if (!Number.isFinite(narrow) || narrow <= 0) return FALLBACK

  return {
    charWidth: narrow,
    wideWidth: Number.isFinite(wide) && wide > 0 ? wide : narrow * 2,
  }
}
