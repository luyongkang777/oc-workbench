export type FsEntry = { path: string; type: 'directory' | 'file' }

function locationQuery(root: string): string {
  return `location[directory]=${encodeURIComponent(root)}`
}

/** Rust 外壳返回 index.html 时注入的一次性令牌；dev 模式下没有，退化成空串。 */
function ocToken(): string {
  const injected = (window as unknown as { __OC_TOKEN?: unknown }).__OC_TOKEN
  return typeof injected === 'string' ? injected : ''
}

/** 所有请求的统一入口：带 x-oc-token 头，非 2xx 抛错（错误体拼进 message）。 */
async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set('x-oc-token', ocToken())
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
  return res.text()
}

/** 服务信息，用来判断后端是否连上。 */
export async function getInfo(): Promise<unknown> {
  return getJson<unknown>('/api/info')
}
