/**
 * 对话断线重试策略。
 *
 * 背景：工作台的「一轮对话」其实分两段——先把消息投递给本地服务（HTTP），
 * 再由服务端去调模型。两段都可能断：
 *   1. 投递这一下网络抖动 / 服务刚重启 / 请求挂住 → sendPrompt 直接抛错，
 *      界面上就是「点发送没反应」；
 *   2. 服务端收下了，但模型调用失败（429 限流、5xx 过载、连接被重置）→
 *      服务端写一条 `type: "idle"` + `outcome: "failed"` 的消息就收工，
 *      前端 `turns.ts` 把 idle 消息整条跳过，界面上就是「发出去之后永远没有回复」。
 *
 * 两种都是用户感知到的「对话断了」。这里给出一套统一的重试判定与节奏，
 * 让上层按同一个口径重试，失败到上限才真正把错误抛给用户。
 *
 * 关键前提（2026-11-16 用 opencode 2.3 实测修正）：`POST /api/session/{id}/prompt`
 * 带同一个 `id`（`msg_` 前缀）重投是**幂等**的——不会把用户的话发两遍，
 * 但**也不会再调度模型**：它只把已有消息还回来，带 `resume: true` 也只是
 * 把这一轮标成 succeeded（实测模型调用次数不变）。
 * 想真正重跑，必须先 `revert/stage + revert/commit` 删掉失败那一轮
 * （只删消息、不动文件），再用同一个 id 重发。实现见 `useChatAutoRetry`。
 *
 * 全是纯函数，不碰 window：node 里能直接单测（scripts/retryPolicy.test.mjs）。
 */

/** 最少重试次数：低于这个数就失去「扛一次抖动」的意义。 */
export const MIN_RETRY_ATTEMPTS = 3
/** 最多重试次数：再多用户等不下去，且多半不是抖动而是真的坏了。 */
export const MAX_RETRY_ATTEMPTS = 8
/** 默认重试次数（落在 3~8 之间）。 */
export const DEFAULT_RETRY_ATTEMPTS = 5

/** 第一次重试前的等待：先给一次瞬时恢复的机会，别让用户干等。 */
const BASE_DELAY_MS = 800
/** 单次等待上限：再长就不如直接报错让用户自己重发。 */
const MAX_DELAY_MS = 8_000
/** 服务端给了 retryAfterMs 时的上限：速率限制可能让我们等很久，最多等 30 秒。 */
const MAX_RETRY_AFTER_MS = 30_000

/**
 * 把外部传入的重试次数收敛到 3~8。
 *
 * 不做「非法值就报错」：这个值可能来自设置文件/环境变量，写坏了不该让
 * 整个重试机制失灵，退回默认值继续跑更合理。
 */
export function normalizeRetryAttempts(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_RETRY_ATTEMPTS
  return Math.min(MAX_RETRY_ATTEMPTS, Math.max(MIN_RETRY_ATTEMPTS, Math.round(n)))
}

/**
 * 第 `attempt` 次重试前该等多久（attempt 从 1 开始，表示「正要进行第几次重试」）。
 *
 * 指数退避：0.8s → 1.6s → 3.2s → 6.4s → 8s（封顶）。服务端明确给了
 * `retryAfterMs` 时尊重它（速率限制常让我们等几秒），但同样要封顶，
 * 免得一个离谱的响应把界面挂十分钟。
 */
export function retryDelay(attempt: number, retryAfterMs?: number): number {
  const step = Math.max(1, Math.floor(attempt) || 1)
  const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (step - 1))
  if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return backoff
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(backoff, Math.round(retryAfterMs)))
}

/**
 * 这些错误重试多少次都不会好，必须立刻告诉用户。
 *
 * 典型是「模型不存在」「密钥错」「参数非法」——重试只是把同一个错误
 * 多播几遍，白白拖住输入框。判据按服务端 StructuredError 的 type / message。
 */
const PERMANENT_PATTERNS = [
  /model unavailable/i,
  /no-route/i,
  /unsupported model/i,
  /model not found/i,
  /invalid request/i,
  /invalid[_ ]?api[_ ]?key/i,
  /unauthorized/i,
  /forbidden/i,
  /permission denied/i,
  /context (length|window) exceed/i,
  /content[- ]?filter/i,
  /session not found/i,
  /location not found/i,
]

/** 网络层这类错误都是「过一会儿可能就好了」。 */
const TRANSIENT_PATTERNS = [
  /fetch failed/i,
  /failed to fetch/i,
  /networkerror/i,
  /network error/i,
  /econnreset/i,
  /econnrefused/i,
  /econnaborted/i,
  /epipe/i,
  /etimedout/i,
  /eai_again/i,
  /enotfound/i,
  /socket hang ?up/i,
  /socket disconnected/i,
  /other side closed/i,
  /请求超时/i,
  /连接.*(失败|中断|重置)/,
  /事件流连接失败/,
  /rate.?limit/i,
  /overloaded/i,
  /too many requests/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway time.?out/i,
]

/** 这些 HTTP 状态码值得重试：暂时性的服务端问题或限流。 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])

/**
 * 从错误文本里挖出 HTTP 状态码。
 *
 * 工作台的 `call()` 抛的是 `` `${status} ${body}` ``，所以形如
 * `503 服务不可用` 会被认成 503；纯网络错误没有状态码。
 */
function statusOf(text: string): number | null {
  const match = /^\s*(\d{3})\b/.exec(text)
  if (!match) return null
  const code = Number(match[1])
  return code >= 400 && code <= 599 ? code : null
}

/** 一段错误文本该不该重试。 */
export function isRetryableText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  // 「模型不存在」这类优先判死：它们有时也会带上 5xx 的状态码前缀
  if (PERMANENT_PATTERNS.some((re) => re.test(trimmed))) return false
  const status = statusOf(trimmed)
  if (status !== null) {
    if (RETRYABLE_STATUS.has(status)) return true
    // 其他 4xx（400/401/403/404/413/422）都是「再发一次也一样」
    if (status < 500) return false
  }
  return TRANSIENT_PATTERNS.some((re) => re.test(trimmed))
}

/** 服务端消息里带的结构化错误（assistant.error / idle 消息的 error）。 */
export type StructuredFailure = {
  type?: string
  message?: string
  status?: number
  retryAfterMs?: number
}

/**
 * 服务端结构化错误该不该重试。
 *
 * 比文本判定多两条信息：`status` 是明确的状态码、`retryAfterMs` 是服务端
 * 自己给的等待时长。两者都优先于文本猜测。
 */
export function isRetryableFailure(failure: StructuredFailure | null | undefined): boolean {
  if (!failure) return false
  const text = `${failure.type ?? ''} ${failure.message ?? ''}`.trim()
  if (PERMANENT_PATTERNS.some((re) => re.test(text))) return false
  const status = typeof failure.status === 'number' ? failure.status : null
  if (status !== null && status >= 400 && status <= 599) {
    return RETRYABLE_STATUS.has(status) || status >= 500
  }
  if (/rate.?limit|overload|timeout|unavailable|provider|network|server/i.test(text)) return true
  return isRetryableText(text)
}

/** 任意抛出的错误（Error / 字符串 / 未知值）该不该重试。 */
export function isRetryableError(err: unknown): boolean {
  if (!err) return false
  if (typeof err === 'string') return isRetryableText(err)
  const message = (err as { message?: unknown }).message
  if (typeof message === 'string') return isRetryableText(message)
  return isRetryableText(String(err))
}

/** 从错误对象里取 `retryAfterMs`（服务端有时会给）。 */
export function retryAfterOf(err: unknown): number | undefined {
  const value = (err as { retryAfterMs?: unknown })?.retryAfterMs
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * 真实失败次数 = max(服务端计数, 本地已排次数 + 1)。
 *
 * 服务端计数在「回撤重投」之后会归零（失败消息被删了），只有本地记的
 * ordered 能反映真实进度；而第一次失败时 ordered 还是 0，所以至少是 1。
 * 抽成纯函数是为了能单测：这个口径错一次，要么提前放弃、要么永不放弃。
 */
export function failureCount(serverAttempts: number, ordered: number): number {
  const server = Number.isFinite(serverAttempts) ? Math.max(0, Math.floor(serverAttempts)) : 0
  const local = Number.isFinite(ordered) ? Math.max(0, Math.floor(ordered)) : 0
  return Math.max(1, server, local + 1)
}

/**
 * 还要不要重试：`attempt` 是**已经失败了几次**（不是重试了几次）。
 *
 * 一次失败 → 重试一次，所以「已经失败 N 次」正好等于「已经重试了 N-1 次」。
 * 要允许重试 maxAttempts 次，就得在失败次数超过 maxAttempts 时才放弃。
 * （写成 `>=` 会让「重试 5 次」实际只重试 4 次，提示文案也会对不上。）
 */
export function shouldGiveUp(attempt: number, maxAttempts: number): boolean {
  return attempt > normalizeRetryAttempts(maxAttempts)
}

/** 重试进度文案：给提示条用，别让用户以为是卡死了。 */
export function retryNoticeText(attempt: number, maxAttempts: number): string {
  const max = normalizeRetryAttempts(maxAttempts)
  return `连接中断，正在自动重试（第 ${Math.min(attempt, max)}/${max} 次）…`
}

/** 放弃时的文案：要带上最后一次的真实原因，别只说「失败了」。 */
export function retryGiveUpText(attempt: number, maxAttempts: number, reason: string): string {
  const max = normalizeRetryAttempts(maxAttempts)
  const detail = reason.trim() || '没有拿到具体原因'
  return `已重试 ${max} 次仍然失败，对话已停止：${detail}`
}
