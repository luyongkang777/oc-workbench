export type FsEntry = { path: string; type: 'directory' | 'file' }

/** 预览上限：超过 500 KB 的文本不渲染（避免主线程生成上万个 DOM 节点把界面卡死）。 */
const MAX_PREVIEW_BYTES = 500 * 1024
const TOO_LARGE_TEXT = '文件过大，暂不支持预览（>500KB）'
/** 单次请求的最长等待时间：后端卡住时不能让 UI 永远转圈。 */
const REQUEST_TIMEOUT_MS = 15_000
/**
 * 重新配对的等待上限：外壳可能要现场拉起服务（约 45 秒）
 * 且请求可能先排队等后台 discover 跑完，留足两份时间。
 */
const RECONNECT_TIMEOUT_MS = 180_000
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
  return typeof injected === 'string' ? injected : ''
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
    const res = await fetch(path, { ...init, headers, signal: controller.signal })
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

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await request(path, init)
  return (await res.json()) as T
}

/** 列目录。relPath 是相对 root 的路径（服务端返回带反斜杠的形式），不传则列根目录。 */
export async function listDir(root: string, relPath?: string): Promise<FsEntry[]> {
  const extra = relPath ? `&path=${encodeURIComponent(relPath)}` : ''
  const data = await getJson<{ data?: FsEntry[] }>(`/api/fs/list?${locationQuery(root)}${extra}`)
  return data.data ?? []
}

/** 读文本文件。relPath 按 / 或 \ 分段编码，避免整段被编码掉。 */
export async function readFile(
  root: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const encoded = relPath.split(/[\\/]+/).map(encodeURIComponent).join('/')
  const res = await request(`/api/fs/read/${encoded}?${locationQuery(root)}`, { signal })

  // 有 Content-Length 就先拦，省掉把整份大文件读进内存。
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_PREVIEW_BYTES) {
    throw new Error(TOO_LARGE_TEXT)
  }

  const text = await res.text()
  // 字符数超过字节上限时必然超限，先走快速路径；否则再按 UTF-8 实际字节数判断
  // （中文/emoji 一个字符占多个字节，只看 length 会放过真正超限的文件）。
  if (text.length > MAX_PREVIEW_BYTES) throw new Error(TOO_LARGE_TEXT)
  if (new TextEncoder().encode(text).length > MAX_PREVIEW_BYTES) {
    throw new Error(TOO_LARGE_TEXT)
  }
  return text
}

/** 服务信息，用来判断后端是否连上。 */
export async function getInfo(): Promise<unknown> {
  return getJson<unknown>('/api/info')
}

/** 让外壳重新执行一次认证（重新 pair），用于「未连接」时的手动重试。 */
export async function reconnect(): Promise<void> {
  await request('/api/reconnect', { method: 'POST' }, RECONNECT_TIMEOUT_MS)
}
