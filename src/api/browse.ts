/**
 * 目录浏览（`/local/browse`）。
 *
 * 手机/浏览器里选项目时用：从盘符开始逐级点进去，而不是让人手输路径。
 * 只列目录（不返回文件内容），路径一律绝对路径。
 */

import { authToken, withBase } from './base.ts'

export type BrowseEntry = { name: string; path: string }

export type BrowseListing = {
  /** 当前目录；空串表示「盘符列表」这一层。 */
  path: string
  /** 上一级；空串表示已经在盘符根。 */
  parent: string
  /** 只在 path 为空时有值。 */
  drives: BrowseEntry[]
  dirs: BrowseEntry[]
  /** 子目录超过上限被截断。 */
  truncated: boolean
}

export type BrowseResult = { ok: true; listing: BrowseListing } | { ok: false; error: string }

export type CreateFolderResult = { ok: true; path: string } | { ok: false; error: string }

const REQUEST_TIMEOUT_MS = 15000

type RawResponse = { ok: boolean; status: number; text: string }

/** body 在超时窗口内读完再清 timer（否则后端只回头不回体时会永久挂住）。 */
async function request(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<RawResponse> {
  const headers = new Headers()
  const token = authToken()
  if (token) headers.set('x-oc-token', token)
  if (init.body !== undefined) headers.set('content-type', 'application/json')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(withBase(path), {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
      signal: controller.signal,
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text }
  } finally {
    clearTimeout(timer)
  }
}

function errorOf(res: RawResponse): string {
  let message = res.text.trim()
  try {
    const parsed = JSON.parse(res.text) as { error?: string }
    if (parsed.error) message = parsed.error
  } catch {
    /* 纯文本就用原文 */
  }
  return message || `HTTP ${res.status}`
}

/** 列某个目录的子目录；`path` 传空串拿盘符列表。 */
export async function listDirectory(path: string): Promise<BrowseResult> {
  try {
    const query = path ? `?path=${encodeURIComponent(path)}` : ''
    const res = await request(`/local/browse${query}`)
    if (!res.ok) return { ok: false, error: errorOf(res) }
    return { ok: true, listing: JSON.parse(res.text) as BrowseListing }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { ok: false, error: '列目录超时' }
    return { ok: false, error: `列目录失败：${String(err)}` }
  }
}

/** 在 parent 下新建一个文件夹（「创建新项目」就是先建空目录）。 */
export async function createFolder(parent: string, name: string): Promise<CreateFolderResult> {
  try {
    const res = await request('/local/browse/mkdir', { method: 'POST', body: { parent, name } })
    if (!res.ok) return { ok: false, error: errorOf(res) }
    const parsed = JSON.parse(res.text) as { path?: string }
    return { ok: true, path: parsed.path ?? `${parent}\\${name}` }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { ok: false, error: '新建文件夹超时' }
    return { ok: false, error: `新建文件夹失败：${String(err)}` }
  }
}

/**
 * 把绝对路径拆成面包屑（纯函数，方便单测）。
 *
 * `C:\Users\a1890` → `[{label:'C:',path:'C:\\'}, {label:'Users',path:'C:\\Users'}, ...]`
 */
export function breadcrumbs(path: string): { label: string; path: string }[] {
  if (!path || !path.trim()) return []
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0)
  const out: { label: string; path: string }[] = []
  let acc = ''
  for (const part of parts) {
    if (!acc) {
      // 盘符：C: → C:\
      acc = part.endsWith(':') ? `${part}\\` : part
    } else {
      acc = acc.endsWith('\\') ? `${acc}${part}` : `${acc}\\${part}`
    }
    out.push({ label: part, path: acc })
  }
  return out
}
