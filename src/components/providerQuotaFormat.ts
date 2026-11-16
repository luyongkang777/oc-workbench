/**
 * 额度 / 用量的纯函数与类型（零依赖，Node 单测可直接 import）。
 *
 * 为什么单独成文件：`api/providerQuota.ts` 要 import `client`（含 fetch / token），
 * Node 直接跑会去解析浏览器依赖。文案与类型放这里，接口层只负责请求。
 */

export type ProviderQuota =
  | {
      ok: true
      kind: 'balance'
      currency: string
      total: string
      available: boolean
      consoleUrl: string
    }
  | {
      ok: true
      kind: 'meters'
      currency: string
      /** OpenCode GO 的三个计量窗口（金额单位已换成美元） */
      meters: {
        fiveHour?: MeterWindow
        week?: MeterWindow
        month?: MeterWindow
      }
      consoleUrl: string
    }
  | {
      ok: true
      kind: 'credits'
      currency: string
      plan: string
      status: string
      /** 剩余额度（美元，= 月付 + 购买 + 赠送） */
      remaining: number
      /** 本计费周期已花（美元） */
      spent: number
      periodEnd: string
      windows: CreditWindow[]
      consoleUrl: string
    }
  | { ok: true; kind: 'console'; consoleUrl: string; note: string }
  | { ok: false; kind?: string; error: string }

export type MeterWindow = {
  used: number
  limit: number
  resetsAt: string
}

export type CreditWindow = {
  label: string
  used: number
  cap: number
  resetAt: string
}

export type ProviderUsage = {
  /** 本机累计 token（input + output） */
  tokens: number
  /** opencode 记录的累计花费（USD，未知价格时为 0） */
  cost: number
  steps: number
}

/** `1234567` → `1.2M`；小数字保留原样。 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`
  return String(Math.round(tokens))
}

/**
 * 额度一行的文案。
 *
 * 只有「有真实金额」时才出文字；`console` 类型要回空串，
 * 界面会改显示「额度：到控制台查看」——**绝不把查不到的额度写成 0**。
 */
export function quotaText(
  quota: ProviderQuota | null | undefined,
  _usage?: ProviderUsage,
): string {
  if (quota && quota.ok && quota.kind === 'balance') {
    const symbol =
      quota.currency === 'USD' ? '$' : quota.currency === 'CNY' ? '¥' : `${quota.currency} `
    const available = quota.available ? '' : '（账号不可用）'
    return `余额 ${symbol}${quota.total}${available}`
  }
  if (quota && quota.ok === false) return '额度查询失败'
  return ''
}

/** 金额：整数不带小数，否则两位。 */
function money(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/** 重置时间：`11-16 17:07`（本地时区，短格式）。 */
function resetText(iso: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * OpenCode 套餐额度：`5小时 $0/12 · 本周 $0.01/30 · 本月 $10.63/60`。
 *
 * 只显示「用掉的 / 上限」——剩余量让用户自己减，比 `剩余 $12` 更少歧义
 * （上限会随套餐调整，写死剩余反而更容易过期）。
 */
export function metersText(quota: ProviderQuota | null | undefined): string {
  if (!quota || !quota.ok || quota.kind !== 'meters') return ''
  const parts: string[] = []
  const labels: Array<[keyof typeof quota.meters, string]> = [
    ['fiveHour', '5 小时'],
    ['week', '本周'],
    ['month', '本月'],
  ]
  for (const [key, label] of labels) {
    const window = quota.meters[key]
    if (!window) continue
    parts.push(`${label} $${money(window.used)}/${money(window.limit)}`)
  }
  return parts.join(' · ')
}

/**
 * Command Code 额度：`剩余 $8.50 · 已用 $1.50 · 5 小时 $0.10/1`。
 *
 * 它的滚动窗口如果接口给了就一并显示（与 CLI 的 `/usage` 一致）。
 */
export function creditsText(quota: ProviderQuota | null | undefined): string {
  if (!quota || !quota.ok || quota.kind !== 'credits') return ''
  const parts = [`剩余 $${money(quota.remaining)}`]
  if (quota.spent > 0) parts.push(`已用 $${money(quota.spent)}`)
  for (const window of quota.windows) {
    if (!window.label) continue
    parts.push(`${window.label} $${money(window.used)}/${money(window.cap)}`)
  }
  return parts.join(' · ')
}

/** 最近一个重置时间（给 title 用）。 */
export function nextResetText(quota: ProviderQuota | null | undefined): string {
  if (!quota || !quota.ok || quota.kind !== 'meters') return ''
  const candidates = [quota.meters.fiveHour, quota.meters.week, quota.meters.month]
  const next = candidates
    .map((window) => (window?.resetsAt ? new Date(window.resetsAt) : null))
    .filter((date): date is Date => Boolean(date) && !Number.isNaN(date!.getTime()))
    .sort((left, right) => left.getTime() - right.getTime())[0]
  return next ? `最近重置：${resetText(next.toISOString())}` : ''
}

/** 本机累计用量文案。 */
export function usageText(usage: ProviderUsage | undefined): string {
  if (!usage || usage.steps === 0) return ''
  const cost = usage.cost > 0 ? ` · $${usage.cost.toFixed(2)}` : ''
  return `本机已用 ${formatTokens(usage.tokens)} tokens${cost}`
}
