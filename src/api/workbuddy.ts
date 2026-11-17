import { localRequest } from './client'

/**
 * WorkBuddy 原生登录（`/local/workbuddy/*`）。
 *
 * 登录由工作台自己做：向腾讯要一个登录页 → 浏览器里登 → 本机每秒轮询令牌。
 * 令牌存在外壳侧，这里只拿「有没有、谁的、什么时候到期」。
 */

export type WorkBuddyStatus = {
  ok: boolean
  configured: boolean
  /** 账号昵称（拿不到账号信息时为空） */
  account: string
  uid: string
  domain: string
  enterpriseId: string
  /** access token 到期时间（毫秒时间戳，0 = 未知） */
  expires: number
  refreshExpiresAt: number
  endpoint: string
  /** 填进 provider 表单的路径（前缀 + 端口由前端按当前 origin 拼） */
  path: string
  /** 本地转发用密钥（opencode 直接用它连本地端口） */
  apiKey: string
}

export type LoginStart = {
  ok: boolean
  state?: string
  url?: string
  error?: string
}

export type LoginPoll = {
  ok: boolean
  /** 还没在浏览器里登完 */
  pending?: boolean
  done?: boolean
  account?: string
  uid?: string
  expires?: number
  error?: string
}

export function getWorkBuddyStatus(): Promise<WorkBuddyStatus> {
  return localRequest<WorkBuddyStatus>('/local/workbuddy/status')
}

export function startWorkBuddyLogin(): Promise<LoginStart> {
  return localRequest<LoginStart>('/local/workbuddy/login/start', undefined, 30_000, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
}

export function pollWorkBuddyLogin(state: string): Promise<LoginPoll> {
  return localRequest<LoginPoll>(
    `/local/workbuddy/login/poll?state=${encodeURIComponent(state)}`,
    undefined,
    30_000,
  )
}

export function logoutWorkBuddy(): Promise<WorkBuddyStatus> {
  return localRequest<WorkBuddyStatus>('/local/workbuddy/logout', undefined, 20_000, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
}

/** `/local/workbuddy/billing` 的返回：积分 + 签到状态。 */
export type WorkBuddyBilling = {
  ok: boolean
  error?: string
  /** 服务端缓存标记 */
  cached?: boolean
  credits?: {
    /** 积分总额（签到活动的 total_credits） */
    total: number
    /** 今天已领 */
    today: number
    /** 每天可领 */
    daily: number
  }
  checkin?: {
    active: boolean
    todayCheckedIn: boolean
    streakDays: number
    dailyCredit: number
    todayCredit: number
    totalCredits: number
  }
  /** 本次请求顺手签到了 */
  checkedInNow?: boolean
  updatedAt?: number
}

/**
 * 读积分与签到状态。
 *
 * `auto=true` 时如果今天还没签到会顺手签一次（面板打开、工作台启动各调一次）。
 */
export function getWorkBuddyBilling(auto = false, refresh = false): Promise<WorkBuddyBilling> {
  const query = [auto ? 'auto=1' : '', refresh ? 'refresh=1' : ''].filter(Boolean).join('&')
  return localRequest<WorkBuddyBilling>(
    `/local/workbuddy/billing${query ? `?${query}` : ''}`,
    undefined,
    20_000,
  )
}

/** 手动签到一次（返回本次积分与最新状态）。 */
export function claimWorkBuddyCheckin(): Promise<{
  ok: boolean
  error?: string
  claim?: { credit: number; streakDays: number; isStreakDay: boolean }
  billing?: WorkBuddyBilling
}> {
  return localRequest('/local/workbuddy/checkin', undefined, 25_000, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
}
