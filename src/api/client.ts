export type FsEntry = { path: string; type: 'directory' | 'file' }

function locationQuery(root: string): string {
  return `location[directory]=${encodeURIComponent(root)}`
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
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
  const res = await fetch(`/api/fs/read/${encoded}?${locationQuery(root)}`)
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.text()
}

/** 服务信息，用来判断后端是否连上。 */
export async function getInfo(): Promise<unknown> {
  return getJson<unknown>('/api/info')
}
