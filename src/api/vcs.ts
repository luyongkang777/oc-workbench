/** 工作区改动（T7）：status 列文件，diff 拿 patch。 */

export type FileStatus = {
  file: string
  additions: number
  deletions: number
  status: 'added' | 'modified' | 'deleted'
}

export type FileDiff = {
  file: string
  patch: string
  additions: number
  deletions: number
}

function token(): string {
  return (window as unknown as { __OC_TOKEN?: string }).__OC_TOKEN ?? ''
}

async function getJson<T>(path: string): Promise<T> {
  const headers = new Headers()
  const current = token()
  if (current) headers.set('x-oc-token', current)
  const res = await fetch(path, { headers })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

function loc(root: string): string {
  return `location%5Bdirectory%5D=${encodeURIComponent(root)}`
}

export async function fetchStatus(root: string): Promise<FileStatus[]> {
  const data = await getJson<{ data?: FileStatus[] }>(`/api/vcs/status?${loc(root)}`)
  return data.data ?? []
}

export async function fetchDiff(root: string): Promise<FileDiff[]> {
  const data = await getJson<{ data?: FileDiff[] }>(`/api/vcs/diff?${loc(root)}&mode=working`)
  return data.data ?? []
}
