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
  | {
      ok: true
      kind: 'points'
      /** WorkBuddy：积分（签到活动的 total/today/daily） */
      credits: { total: number; today: number; daily: number }
      checkin: { todayCheckedIn: boolean; streakDays: number }
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
 * 剩余百分比（0~100，四舍五入）。
 *
 * 上限无效（0、负数、NaN）时返回 null —— **不编数字**：查不到就整段不写，
 * 而不是显示「剩 0%」让人以为额度耗尽了。
 */
export function percentLeft(used: number, limit: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null
  const left = Math.min(100, Math.max(0, ((limit - used) / limit) * 100))
  // 不满 100% 的一律向下取整：`本周 $0.01/30` 不能显示成「剩 100%」，
  // 否则「用过一点」和「完全没用」在界面上分不出来。
  return left >= 100 ? 100 : Math.floor(left)
}

/** `5 小时 剩 98%`；上限无效时返回空串（调用方跳过这一段）。 */
function windowLeft(label: string, used: number, limit: number): string {
  const percent = percentLeft(used, limit)
  return percent === null ? '' : `${label} 剩 ${percent}%`
}

/**
 * OpenCode 套餐额度：`5 小时 剩 100% · 本周 剩 100% · 本月 剩 82%`。
 *
 * 显示「还剩百分之多少」而不是金额：上限会随套餐调整，百分比一眼看出快用完了没有；
 * 真实金额放在 title 里（`quotaDetailText`），需要算账时再悬停看。
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
    const text = windowLeft(label, window.used, window.limit)
    if (text) parts.push(text)
  }
  return parts.join(' · ')
}

/**
 * Command Code 额度：`剩余 27% · 5 小时 剩 98% · 本周 剩 45%`。
 *
 * 总剩余按 `remaining / (remaining + spent)` 算（两者的和 = 本周期总量）；
 * 滚动窗口按各自上限算，接口给了就一并显示（与 CLI 的 `/usage` 一致）。
 */
export function creditsText(quota: ProviderQuota | null | undefined): string {
  if (!quota || !quota.ok || quota.kind !== 'credits') return ''
  const parts: string[] = []
  const total = percentLeft(quota.spent, quota.remaining + quota.spent)
  if (total !== null) parts.push(`剩余 ${total}%`)
  for (const window of quota.windows) {
    if (!window.label) continue
    const text = windowLeft(window.label, window.used, window.cap)
    if (text) parts.push(text)
  }
  // 新账号（剩余与花费都是 0、也没有窗口）算不出百分比：写「剩余 —」，
  // 不要回空串 —— 那会让列表上整行额度消失，看起来像没有额度。
  if (parts.length === 0) return '剩余 —'
  return parts.join(' · ')
}

/**
 * 金额明细（给 title 用，主行只显示百分比）。
 *
 * 与 `metersText` / `creditsText` 同一批数据，只是换成原始金额，
 * 让用户在需要核对时悬停就能看到，不占主行位置。
 */
export function quotaDetailText(quota: ProviderQuota | null | undefined): string {
  if (!quota || !quota.ok) return ''
  if (quota.kind === 'meters') {
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
  if (quota.kind === 'credits') {
    const parts = [`剩余 $${money(quota.remaining)}`]
    if (quota.spent > 0) parts.push(`已用 $${money(quota.spent)}`)
    for (const window of quota.windows) {
      if (!window.label) continue
      parts.push(`${window.label} $${money(window.used)}/${money(window.cap)}`)
    }
    return parts.join(' · ')
  }
  return ''
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

/**
 * WorkBuddy 积分：`积分 1600 · 连续 16 天 · 今日已签`。
 *
 * 它没有「上限」概念，只有签到累计的积分余额，所以不套用余额/百分比格式。
 */
export function pointsText(quota: ProviderQuota | null | undefined): string {
  if (!quota || !quota.ok || quota.kind !== 'points') return ''
  const total = Number(quota.credits?.total ?? 0)
  const streak = Number(quota.checkin?.streakDays ?? 0)
  const parts = ['积分 ' + (Number.isInteger(total) ? String(total) : total.toFixed(2))]
  if (streak > 0) parts.push('连续 ' + streak + ' 天')
  parts.push(quota.checkin?.todayCheckedIn ? '今日已签' : '今日未签')
  return parts.join(' · ')
}

/** 本机累计用量文案。 */
export function usageText(usage: ProviderUsage | undefined): string {
  if (!usage || usage.steps === 0) return ''
  const cost = usage.cost > 0 ? ` · $${usage.cost.toFixed(2)}` : ''
  return `本机已用 ${formatTokens(usage.tokens)} tokens${cost}`
}
