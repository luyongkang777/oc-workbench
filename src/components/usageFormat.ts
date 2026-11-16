/**
 * 用量页的纯函数（零依赖，Node 单测可直接 import）。
 *
 * 口径对齐 magpie 自己的用量页：
 *   * Token 默认含缓存（输入 + 输出 + 缓存读 + 缓存写），可以切成不含缓存；
 *   * 缓存命中率 = cacheRead / (input + cacheRead + cacheWrite)；
 *   * 费用是按 models.dev 单价估的，认不出价格的调用单列「未计价」，不按 0 元算。
 */

import type { UsagePoint, UsageTotals } from '../api/usage'

/** `1234567` → `1.2M`；大数不给小数点（`956123456` → `956M`）。 */
export function formatUsageTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1e9) return `${trim(value / 1e9, value >= 1e10 ? 0 : 1)}B`
  if (value >= 1e6) return `${trim(value / 1e6, value >= 1e8 ? 0 : 1)}M`
  if (value >= 1e3) return `${trim(value / 1e3, value >= 1e4 ? 0 : 1)}K`
  return String(Math.round(value))
}

/** 去掉尾随的 `.0`：`956.0` → `956`。 */
function trim(value: number, digits: number): string {
  const text = value.toFixed(digits)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/** 费用：`$10.36`；很小的金额多给一位。 */
export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

/** 缓存命中率：0.9714 → `97%`。 */
export function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—'
  return `${Math.round(rate * 100)}%`
}

/**
 * Token 总数。
 *
 * `withCache` 打开时把缓存读/写也算进来（magpie 面板的默认口径）；
 * 关掉就是「输入 + 输出」。两种口径都有人看：含缓存反映真实上下文量，
 * 不含缓存更接近计费输入。
 */
export function tokensOf(totals: UsageTotals, withCache: boolean): number {
  const base = totals.input + totals.output
  return withCache ? base + totals.cacheRead + totals.cacheWrite : base
}

/** 缓存命中率：读到的缓存 / 整个提示词（写入也算提示词）。与后端同口径。 */
export function hitRateOf(
  totals: Pick<UsageTotals, 'input' | 'cacheRead' | 'cacheWrite'>,
): number | null {
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite
  return prompt === 0 ? null : totals.cacheRead / prompt
}

/** 卡片里的提示：失败 / 重试 / 取消 / 未计价。 */
export function requestNote(totals: UsageTotals): string {
  const parts: string[] = []
  if (totals.errors > 0) parts.push(`${totals.errors} 次失败`)
  if (totals.retried > 0) parts.push(`${totals.retried} 次重试后成功`)
  if (totals.canceled > 0) parts.push(`${totals.canceled} 次取消`)
  if (totals.unpriced > 0) parts.push(`${totals.unpriced} 次未计价`)
  return parts.join(' · ')
}

/** 客户端 id → 展示名。 */
const AGENT_NAMES: Record<string, string> = {
  opencode: '本地会话',
  curl: 'curl',
  cursor: 'Cursor',
  node: 'Node',
  magpie: 'magpie 自检',
}

/** 服务商 id → 展示名。 */
const PROVIDER_NAMES: Record<string, string> = {
  deepseek: 'DeepSeek',
  magpie: 'Magpie',
  purge: 'Purge',
  commandcode: 'Command Code',
  'command-code': 'Command Code',
  'opencode-go': 'OpenCode Go',
  workbuddy: 'WorkBuddy',
  zcode: 'ZCode',
  cursor: 'Cursor',
  teleagent: 'TeleAgent',
}

export function sourceName(id: string, kind: 'agent' | 'provider' | 'model'): string {
  if (!id) return '未知'
  if (kind === 'agent') return AGENT_NAMES[id] ?? id
  if (kind === 'provider') return PROVIDER_NAMES[id] ?? id
  return id
}

/** 图表指标。 */
export type UsageMetric = 'token' | 'cost' | 'calls'

/** 一根柱子在该指标下的数值。 */
export function pointValue(point: UsagePoint, metric: UsageMetric, withCache: boolean): number {
  if (metric === 'cost') return point.cost
  if (metric === 'calls') return point.calls
  return point.input + point.output + (withCache ? point.cacheRead + point.cacheWrite : 0)
}

/** 峰值；**0 表示这个范围里该指标没有数据**（图表据此显示「峰值 —」）。 */
export function seriesPeak(points: UsagePoint[], metric: UsageMetric, withCache: boolean): number {
  let peak = 0
  for (const point of points) {
    const value = pointValue(point, metric, withCache)
    if (value > peak) peak = value
  }
  return peak
}

/** 柱子里「输出」那一段的比例（0~1）；只有 Token 模式分段。 */
export function outputShare(
  point: UsagePoint,
  metric: UsageMetric,
  withCache: boolean,
): number {
  if (metric !== 'token') return 0
  const total = pointValue(point, metric, withCache)
  if (total <= 0) return 0
  return point.output / total
}

/** 柱子的整体高度百分比；有值就至少 1.5%，否则空柱看不见。 */
export function barHeight(
  point: UsagePoint,
  metric: UsageMetric,
  peak: number,
  withCache: boolean,
): number {
  const value = pointValue(point, metric, withCache)
  if (value <= 0) return 0
  return Math.max(1.5, (value / peak) * 100)
}

/** 柱子的悬停提示。 */
export function barTitle(
  point: UsagePoint,
  bucket: 'hour' | 'day',
  withCache: boolean,
): string {
  const when = bucket === 'hour' ? `${point.label}:00` : point.time || point.label
  if (point.calls === 0) return `${when} · 没有请求`
  const tokens = point.input + point.output + (withCache ? point.cacheRead + point.cacheWrite : 0)
  const parts = [`${when} · ${formatUsageTokens(tokens)} tokens`, `${point.calls} 次请求`]
  if (point.cost > 0) parts.push(formatCost(point.cost))
  return parts.join(' · ')
}

/** X 轴标签的抽稀步长：柱子太多时只画几个，避免糊成一片。 */
export function labelStep(count: number): number {
  if (count <= 8) return 1
  if (count <= 31) return Math.ceil(count / 6)
  return Math.ceil(count / 5)
}
