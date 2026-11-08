export type FsEntry = { path: string; type: 'directory' | 'file' }

/** 预览上限：超过 2 MB 的文本不渲染（避免主线程生成上万个 DOM 节点把界面卡死）。 */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024
const TOO_LARGE_TEXT = '文件过大，暂不支持预览'

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

/** 所有请求的统一入口：带 x-oc-token 头，非 2xx 抛错（错误体拼进 message）。 */
async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const token = ocToken()
  // 空令牌不发头：dev 模式下 /api 由 Vite 代理，不经过外壳的 token 校验。
  if (token) headers.set('x-oc-token', token)
  else headers.delete('x-oc-token')
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res
}

async function getJson<T>(path: string): Promise<T> {
  const res = await request(path)
  return (await res.json()) as T
}

/** 列目录。relPath 是相对 root 的路径（服务端返回带反斜杠的形式），不传则列根目录。 */
export async function listDir(root: string, relPath?: string): Promise<FsEntry[]> {
  const extra = relPath ? `&path=${encodeURIComponent(relPath)}` : ''
  const data = await getJson<{ data?: FsEntry[] }>(`/api/fs/list?${locationQuery(root)}${extra}`)
  return data.data ?? []
}

/** 读文本文件。relPath 按 / 或 \ 分段编码，避免整段被编码掉。 */
export async function readFile(root: string, relPath: string): Promise<string> {
  const encoded = relPath.split(/[\\/]+/).map(encodeURIComponent).join('/')
  const res = await request(`/api/fs/read/${encoded}?${locationQuery(root)}`)

  // 有 Content-Length 就先拦，省掉把整份大文件读进内存。
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_PREVIEW_BYTES) {
    throw new Error(TOO_LARGE_TEXT)
  }

  const text = await res.text()
  if (text.length > MAX_PREVIEW_BYTES) throw new Error(TOO_LARGE_TEXT)
  return text
}

/** 服务信息，用来判断后端是否连上。 */
export async function getInfo(): Promise<unknown> {
  return getJson<unknown>('/api/info')
}
