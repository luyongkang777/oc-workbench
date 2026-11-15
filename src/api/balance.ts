/**
 * DeepSeek 官方余额（`/local/balance` 系列接口）。
 *
 * 密钥只在外壳里读、由外壳直接请求官方接口；页面拿到的是已经清洗好的数字，
 * 不会有 key 出现在这边（状态接口也只回掩码）。远程页面（手机）靠持久凭据走同一条本地通道。
 */

import { authToken, withBase } from './base.ts'

/** 密钥来源，界面 title 里显示，排障时一眼看出用的是哪一个。 */
export type BalanceSource = 'settings' | 'magpie' | 'env'

export type DeepSeekBalance =
  | {
      ok: true
      source?: BalanceSource
      currency?: string
      /** 总余额，官方给的是字符串（避免浮点误差）。 */
      total?: string
      /** 赠送余额。 */
      granted?: string
      /** 充值余额。 */
      toppedUp?: string
      /** 账号是否可用；false = 余额耗尽或未开通。 */
      available?: boolean
      /** 查询时间（秒级）。 */
      fetchedAt?: number
      /** 这次是不是直接回的缓存。 */
      cached?: boolean
    }
  | { ok: false; error?: string; status?: number }

/** 密钥配置状态（永远不含完整 key）。 */
export type BalanceStatus = {
  configured: boolean
  source: 'settings' | 'env' | 'none'
  /** 形如 `sk-9fc…e0ff`。 */
  masked: string
  /** magpie 配置里有没有可读的官方 key（面板上的「从 magpie 读取」按钮据此显示）。 */
  hasMagpie: boolean
  magpieMasked: string
}

export type BalanceMutation =
  | { ok: true; status: BalanceStatus }
  | { ok: false; error: string }

/**
 * 「余额该刷新了」的广播事件。
 *
 * 事件流里每轮模型调用结束（step.ended）都会派发一次：那一刻刚产生费用，
 * 是最该更新的时机。用 window 事件而不是把余额状态提到 App，是因为
 * 顶栏胶囊和聊天逻辑没有任何其他耦合。
 */
export const BALANCE_REFRESH_EVENT = 'oc:balance-refresh'

/**
 * 强制刷新的最小间隔。
 *
 * 一次对话里 step.ended 可能连着来好几条，每次都打官方接口既没必要也容易触发限频；
 * 2.5 秒窗口内的重复请求直接忽略（后端还有 4 秒缓存兜着）。
 */
export const FORCE_REFRESH_GAP_MS = 2500

export function canForceRefresh(lastAt: number, now: number, gap = FORCE_REFRESH_GAP_MS): boolean {
  return now - lastAt >= gap
}

/** 余额接口本身不慢；留足余量，避免网络抖动时界面一直转。 */
const REQUEST_TIMEOUT_MS = 15000

type RequestOptions = { method?: 'GET' | 'POST'; body?: unknown; refresh?: boolean }

type RawResponse = { ok: boolean; status: number; text: string }

/**
 * 发请求并把 body 一起读完。
 *
 * **body 必须在超时窗口内读完再清 timer**：只 await 到响应头就 clearTimeout 的话，
 * 后端一旦只回头不回体，`res.text()` 会永远挂着 —— 调用方的 busy 标志再也清不掉，
 * 之后所有轮询都被当成「还在查」直接丢弃（实测：界面余额停在旧值十几分钟不动）。
 */
async function request(path: string, options: RequestOptions = {}): Promise<RawResponse> {
  const headers = new Headers()
  // dev 走 Vite 代理（cookie 由代理注入），这时没有 token，别发空值。
  const token = authToken()
  if (token) headers.set('x-oc-token', token)
  if (options.body !== undefined) headers.set('content-type', 'application/json')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const suffix = options.refresh ? '?refresh=1' : ''
    const res = await fetch(withBase(`${path}${suffix}`), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      signal: controller.signal,
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text }
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchDeepSeekBalance(refresh = false): Promise<DeepSeekBalance> {
  try {
    const res = await request('/local/balance', { refresh })
    if (!res.ok) {
      // 403 在远程页面没凭据时很常见，说人话就行，不要当成服务坏了。
      return {
        ok: false,
        status: res.status,
        error: res.status === 403 ? '没有访问凭据（远程页面请先登录）' : `HTTP ${res.status}`,
      }
    }
    if (!res.text) return { ok: false, error: '余额接口返回空响应' }
    return JSON.parse(res.text) as DeepSeekBalance
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: '查询余额超时' }
    }
    return { ok: false, error: `查询余额失败：${String(err)}` }
  }
}

/** 读密钥状态（掩码 + 来源 + magpie 有没有可读的官方 key）。 */
export async function fetchBalanceStatus(): Promise<BalanceStatus | null> {
  try {
    const res = await request('/local/balance/status')
    if (!res.ok) return null
    return JSON.parse(res.text) as BalanceStatus
  } catch {
    return null
  }
}

async function mutate(path: string, body: unknown): Promise<BalanceMutation> {
  try {
    const res = await request(path, { method: 'POST', body })
    if (!res.ok) {
      // 外壳的 json_error 回的是 `{"error":"..."}`；取里面那句话，
      // 直接把 JSON 丢给用户会看到一串括号引号。
      let message = res.text.trim()
      try {
        const parsed = JSON.parse(res.text) as { error?: string }
        if (parsed.error) message = parsed.error
      } catch {
        /* 不是 JSON 就按纯文本展示 */
      }
      return { ok: false, error: message || `HTTP ${res.status}` }
    }
    return { ok: true, status: JSON.parse(res.text) as BalanceStatus }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: '请求超时' }
    }
    return { ok: false, error: `请求失败：${String(err)}` }
  }
}

/** 保存用户手填的官方密钥。 */
export function saveBalanceKey(key: string): Promise<BalanceMutation> {
  return mutate('/local/balance/key', { key })
}

/** 清除已保存的密钥（环境变量那条不受影响）。 */
export function clearBalanceKey(): Promise<BalanceMutation> {
  return mutate('/local/balance/key', { action: 'clear' })
}

/** 主动从 magpie 读官方 key 并保存（只在用户点按钮时调用）。 */
export function detectMagpieKey(): Promise<BalanceMutation> {
  return mutate('/local/balance/detect', {})
}
