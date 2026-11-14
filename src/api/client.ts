import { remoteTokenKey, withBase } from './base.ts'
export type FsEntry = { path: string; type: 'directory' | 'file' }

/** 单次请求的最长等待时间：后端卡住时不能让 UI 永远转圈。 */
const REQUEST_TIMEOUT_MS = 15_000
/**
 * 重新配对的等待上限：外壳可能要现场拉起服务（启动窗口 150 秒）
 * 且请求可能先排队等后台 discover 跑完，留足两份时间。
 */
const RECONNECT_TIMEOUT_MS = 300_000
/** 错误信息最多展示多少个字符：别把整坨响应体原样塞进 UI。 */
const MAX_ERROR_TEXT = 200

function locationQuery(root: string): string {
  return `location[directory]=${encodeURIComponent(root)}`
}

/**
 * 外壳经 IPC 下发到 window.__OC_TOKEN 的本次启动令牌（见 api/auth.ts）。
 * Vite dev 模式下没有令牌，退化成空串。
 */
function ocToken(): string {
  const injected = (window as unknown as { __OC_TOKEN?: unknown }).__OC_TOKEN
  if (typeof injected === 'string' && injected) return injected
  // 浏览器/远程访问没有 IPC：凭据由入口 `?t=` 存进 localStorage。
  // 不能只靠 cookie——手机浏览器（尤其微信内置）经常存不住，表现为 /api 全 403。
  try {
    return window.localStorage.getItem(remoteTokenKey()) ?? ''
  } catch {
    return ''
  }
}

/** 把非 2xx 的响应压成一句短消息：JSON 只取 error/message，整体不超过 200 字符。 */
async function errorText(res: Response): Promise<string> {
  let detail = ''
  try {
    const raw = await res.text()
    try {
      const body = JSON.parse(raw) as { error?: unknown; message?: unknown }
      const field = body.error ?? body.message
      if (typeof field === 'string') detail = field
    } catch {
      // 不是 JSON：退化成原文，下面统一截断
      detail = raw
    }
  } catch {
    // 响应体读不出来（连接已断）就只报状态码
  }

  detail = detail.replace(/\s+/g, ' ').trim()
  const message = detail ? `${res.status} ${detail}` : `${res.status}`
  return message.length > MAX_ERROR_TEXT ? `${message.slice(0, MAX_ERROR_TEXT - 1)}…` : message
}

/**
 * 所有请求的统一入口：带 x-oc-token 头，非 2xx 抛错（错误体只保留一句话）。
 *
 * 15 秒硬超时由内部 AbortController 管；调用方传入的 signal 只用来取消
 * （例如切换文件时放弃上一个请求），两种中止都会让 fetch 立刻 reject。
 */
async function request(
  path: string,
  init?: RequestInit,
  // 个别请求（reconnect）要等外壳自动拉起服务，比普通接口慢得多
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const headers = new Headers(init?.headers)
  const token = ocToken()
  // 空令牌不发头：dev 模式下 /api 由 Vite 代理，不经过外壳的 token 校验。
  if (token) headers.set('x-oc-token', token)
  else headers.delete('x-oc-token')

  const controller = new AbortController()
  let timedOut = false
  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onCancel = () => controller.abort()
  // 调用方传进来的 signal 已经中止过：直接当取消处理，别真发请求
  if (init?.signal?.aborted) controller.abort()
  else init?.signal?.addEventListener('abort', onCancel)

  try {
    const res = await fetch(withBase(path), { ...init, headers, signal: controller.signal })
    if (!res.ok) throw new Error(await errorText(res))
    return res
  } catch (err) {
    if (timedOut) throw new Error('请求超时')
    throw err
  } finally {
    window.clearTimeout(timer)
    init?.signal?.removeEventListener('abort', onCancel)
  }
}
/**
 * 在途 GET 的去重表：同一个地址在同一时刻只发一次。
 *
 * 多个面板会同时问同一份数据（文件树与查看区都 stat 同一个文件、顶栏与会话灯
 * 都拉会话列表），以前每次各开一个连接，把外壳的请求线程占满。只合并「没有
 * signal、没指定 method」的请求——带 signal 的调用方要能单独取消，不能共享。
 */
const inflightGet = new Map<string, Promise<unknown>>()

function dedupeKey(path: string, init?: RequestInit): string | null {
  if (init?.method && init.method.toUpperCase() !== 'GET') return null
  if (init?.signal) return null
  return path
}

function sharedGet<T>(
  path: string,
  timeoutMs: number | undefined,
  key: string,
  init?: RequestInit,
): Promise<T> {
  const hit = inflightGet.get(key)
  if (hit) return hit as Promise<T>
  const pending = request(path, init, timeoutMs).then((res) => res.json() as Promise<T>)
  inflightGet.set(key, pending)
  const cleanup = () => {
    if (inflightGet.get(key) === pending) inflightGet.delete(key)
  }
  void pending.then(cleanup, cleanup)
  return pending
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const key = dedupeKey(path, init)
  if (key) return sharedGet<T>(key, undefined, key, init)
  const res = await request(path, init)
  return (await res.json()) as T
}

/** 列目录。relPath 是相对 root 的路径（服务端返回带反斜杠的形式），不传则列根目录。 */
export async function listDir(root: string, relPath?: string): Promise<FsEntry[]> {
  const extra = relPath ? `&path=${encodeURIComponent(relPath)}` : ''
  const data = await getJson<{ data?: FsEntry[] }>(`/api/fs/list?${locationQuery(root)}${extra}`)
  return data.data ?? []
}

/**
 * 请求外壳自己的本地接口（`/local/*`）：与 `/api/*` 同一套 token / 超时 / 错误处理。
 *
 * 本地接口直接读磁盘，不经过 opencode；大文件的 `stat` 要扫一遍建行索引，
 * 所以允许调用方放宽超时（默认仍是 15 秒）。
 */
export async function localRequest<T>(
  path: string,
  signal?: AbortSignal,
  timeoutMs?: number,
  init?: RequestInit,
): Promise<T> {
  // 本地接口（读盘、stat、git status）是最容易被多个面板同时点的，能合就合。
  const key = signal ? null : dedupeKey(path, init)
  if (key) return sharedGet<T>(key, timeoutMs, key, { ...init, cache: 'no-store' })
  const res = await request(path, { ...init, signal, cache: 'no-store' }, timeoutMs)
  return (await res.json()) as T
}

/** 本地接口的二进制响应（图片预览）。 */
export async function localRequestBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const res = await request(path, { signal, cache: 'no-store' })
  return await res.blob()
}

/** 服务信息，用来判断后端是否连上。 */
export async function getInfo(): Promise<unknown> {
  return getJson<unknown>('/api/info')
}

/**
 * 外壳自己的连接状态（`GET /api/state`）：是否连上、连到哪、最近一次失败原因。
 *
 * 断开态用它直接告诉用户「为什么没连上」，而不是等用户点一次「重试」才知道。
 * 只读、不触发配对，所以断开时每次探活都问一次也没有额外代价。
 */
export type ShellState = { connected: boolean; base: string | null; error: string | null }

export async function getShellState(): Promise<ShellState> {
  return getJson<ShellState>('/api/state')
}

/** 让外壳重新执行一次认证（重新 pair），用于「未连接」时的手动重试。 */
export async function reconnect(): Promise<void> {
  await request('/api/reconnect', { method: 'POST' }, RECONNECT_TIMEOUT_MS)
}
