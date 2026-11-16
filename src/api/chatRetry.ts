/**
 * 带重试的会话请求（对话链路专用）。
 *
 * `api/client.ts` 的 `request()` 只管「一次请求」：15 秒超时、非 2xx 抛错，
 * 没有重试。对话链路不能只靠它——用户点一次发送就等，抖动一下整条对话就断了。
 *
 * 这里只开放一个入口：**发送消息**——带固定 message id 重投。
 * 服务端按 id 幂等（实测重投返回同一条消息、`time.created` 不变），
 * 所以重试不会把用户的话发两遍，但会重新调度一轮模型调用。
 *
 * 为什么不给所有请求都加重试：`/api/session/{id}/compact`、`/command`、
 * `/interrupt` 这类不是幂等的，重试可能真的跑两遍。要别的接口也重试，
 * 必须先确认它幂等，再单独开放。
 */
import { authToken, withBase } from './base.ts'
import { isRetryableError, retryAfterOf, retryDelay } from '../components/retryPolicy.ts'
import type { PromptFile } from './chat'

/**
 * 单次请求的超时。
 *
 * 原来这里没有任何超时：服务端接了连接却不回包时，发送按钮会永远转圈，
 * 重试也就永远轮不到。和 `client.ts` 的 15 秒不同，投递 prompt 之后服务端
 * 可能要先排队，给宽一点（30 秒），超时后当作可重试的失败继续重试。
 */
const REQUEST_TIMEOUT_MS = 30_000

/** 抛给上层时保留状态码，重试判定和文案都要用。 */
export class RetryableRequestError extends Error {
  status: number | null
  retryAfterMs?: number

  constructor(message: string, status: number | null, retryAfterMs?: number) {
    super(message)
    this.name = 'RetryableRequestError'
    this.status = status
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}

type RetryOptions = {
  /** 最多试几次（含第一次），已由 retryPolicy 收敛到 3~8 */
  maxAttempts: number
  /** 每次失败后回调：attempt 是刚失败的次数，delayMs 是即将等待的时长 */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void
  /** 用来中止重试（用户点了停止、切了会话） */
  signal?: AbortSignal
}

/** 等一会儿，可被 signal 打断。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 把非 2xx 响应压成一句短错误，并尽量挖出 status / retryAfterMs。 */
async function toError(res: Response): Promise<RetryableRequestError> {
  let raw = ''
  try {
    raw = await res.text()
  } catch {
    // 连接已断：只有状态码可用
  }
  let detail = raw
  let retryAfterMs: number | undefined
  try {
    const body = JSON.parse(raw) as {
      error?: unknown
      message?: unknown
      retryAfterMs?: unknown
    }
    const field = body.error ?? body.message
    if (typeof field === 'string') detail = field
    if (typeof body.retryAfterMs === 'number') retryAfterMs = body.retryAfterMs
  } catch {
    // 不是 JSON：用原文
  }
  // 响应头里的 Retry-After（秒）也认
  const header = res.headers.get('retry-after')
  if (retryAfterMs === undefined && header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds > 0) retryAfterMs = Math.round(seconds * 1000)
  }
  detail = detail.replace(/\s+/g, ' ').trim()
  const message = detail ? `${res.status} ${detail}` : `${res.status}`
  return new RetryableRequestError(
    message.length > 300 ? `${message.slice(0, 299)}…` : message,
    res.status,
    retryAfterMs,
  )
}

/**
 * 一次带重试的请求。
 *
 * `signal` 中止时立刻停（不重试），因为那是用户主动取消，不是可恢复的失败。
 */
async function requestWithRetry(
  path: string,
  init: RequestInit,
  options: RetryOptions,
): Promise<Response> {
  const { maxAttempts, onRetry, signal } = options
  let attempt = 0
  let lastError: unknown = null

  while (attempt < maxAttempts) {
    attempt += 1
    // 每次尝试单独一个 controller：既接外部 signal（用户取消），
    // 又能自己超时。超时算可重试失败，用户取消不算。
    const controller = new AbortController()
    let timedOut = false
    const timer = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, REQUEST_TIMEOUT_MS)
    const onCancel = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', onCancel, { once: true })
    try {
      const headers = new Headers(init.headers)
      const token = authToken()
      if (token) headers.set('x-oc-token', token)
      const res = await fetch(withBase(path), { ...init, headers, signal: controller.signal })
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onCancel)
      if (res.ok) return res
      const error = await toError(res)
      // 4xx 里除了限流/冲突，其他都是「再发一次也一样」
      if (!isRetryableError(error) || attempt >= maxAttempts) throw error
      lastError = error
    } catch (err) {
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onCancel)
      // 用户主动取消：不重试，原样抛
      if (signal?.aborted) throw err
      // 自己超时：当成可重试的失败（文案要明确，别让用户以为是网络错）
      if (timedOut) {
        lastError = new RetryableRequestError('请求超时（服务端 30 秒没有响应）', null)
        if (attempt >= maxAttempts) throw lastError
        // 走到下面的退避
      } else {
        lastError = err
        if ((err as Error)?.name === 'AbortError') throw err
        if (!isRetryableError(err) || attempt >= maxAttempts) throw err
      }
    }

    // 还有机会：等一下再试
    const reason = (lastError as Error)?.message ?? String(lastError)
    const delayMs = retryDelay(attempt, retryAfterOf(lastError))
    try {
      onRetry?.(attempt, delayMs, reason)
      await sleep(delayMs, signal)
    } catch (err) {
      // sleep 被 signal 打断：当成用户取消
      throw err
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * 发送用户消息（带幂等重试）。
 *
 * `messageID` 必须是调用方生成的固定 `msg_` id：重投时服务端会认成同一条、
 * 不会重复插入用户消息。但**它不会重新调度模型**（opencode 2.3 实测：同 id
 * 重投后模型调用次数不变，只是把这一轮标成 succeeded）。真正重跑要先
 * `revert/stage + revert/commit` 删掉失败那一轮——见 `useChatAutoRetry`。
 */
export async function sendPromptWithRetry(
  sessionID: string,
  text: string,
  files: PromptFile[],
  messageID: string,
  options: RetryOptions,
): Promise<void> {
  const body: { id: string; text: string; files?: PromptFile[]; resume: boolean } = {
    id: messageID,
    text,
    resume: true,
  }
  if (files.length > 0) body.files = files
  await requestWithRetry(
    `/api/session/${encodeURIComponent(sessionID)}/prompt`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    options,
  )
}

/**
 * 生成本次发送的消息 id。
 *
 * 服务端的 ID 是 `msg_` + 一串字符；这里不需要和服务端同构，只要满足
 * `^msg_` 且同一轮重试期间不变即可。用随机串而不是时间戳：同一毫秒内
 * 连发两条（很常见）时间戳会撞。
 */
export function newMessageID(): string {
  const rand = () => Math.random().toString(36).slice(2, 10)
  return `msg_ocw${Date.now().toString(36)}${rand()}${rand()}`
}
