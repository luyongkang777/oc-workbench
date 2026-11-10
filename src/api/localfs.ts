import { localRequest, localRequestBlob } from './client'

/** 文件元信息：size 是字节数，lineCount 为 0 且 binary 为真表示二进制文件。 */
export type FileStat = {
  size: number
  mtimeMs: number
  lineCount: number
  encoding: string
  binary: boolean
}

export type LineWindow = {
  start: number
  text: string
  next: number
  eof: boolean
  lineCount: number
}

export type LocalEntry = {
  path: string
  type: 'directory' | 'file'
  size?: number | null
}

/** 大文件建行索引要扫一遍磁盘，给 stat 放宽到 2 分钟（慢盘上 2GB 也够）。 */
const STAT_TIMEOUT_MS = 120_000
/** 页读也可能触发重扫（索引缓存只有 8 份），别用默认 15 秒。 */
const READ_TIMEOUT_MS = 60_000

function query(root: string, rel: string): string {
  return `root=${encodeURIComponent(root)}&path=${encodeURIComponent(rel)}`
}

/** 列目录：目录在前、按名字排序，文件带 size。 */
export async function listDirLocal(
  root: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<LocalEntry[]> {
  const res = await localRequest<{ entries?: LocalEntry[] }>(
    `/local/fs/list?${query(root, relPath)}`,
    signal,
  )
  return res.entries ?? []
}

export async function statFile(
  root: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<FileStat> {
  return localRequest<FileStat>(`/local/fs/stat?${query(root, relPath)}`, signal, STAT_TIMEOUT_MS)
}

/** 读第 start 行开始的 lines 行。 */
export async function readLines(
  root: string,
  relPath: string,
  start: number,
  lines: number,
  signal?: AbortSignal,
): Promise<LineWindow> {
  const extra = `&start=${start}&lines=${lines}`
  return localRequest<LineWindow>(
    `/local/fs/read?${query(root, relPath)}${extra}`,
    signal,
    READ_TIMEOUT_MS,
  )
}

export type SearchMatch = { line: number; text: string }
export type SearchResult = { matches: SearchMatch[]; truncated: boolean; lineCount: number }

/** 整文件搜索（大小写不敏感）。返回 0 基行号 + 截断后的行文本。 */
export async function searchFile(
  root: string,
  relPath: string,
  keyword: string,
  limit = 500,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const extra = `&q=${encodeURIComponent(keyword)}&limit=${limit}`
  return localRequest<SearchResult>(
    `/local/fs/search?${query(root, relPath)}${extra}`,
    signal,
    READ_TIMEOUT_MS,
  )
}

/** 整份文本（给 Markdown 预览用）；超过 1MB 时服务端回 413。 */
export async function readText(
  root: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await localRequest<{ text?: string }>(
    `/local/fs/text?${query(root, relPath)}`,
    signal,
  )
  return res.text ?? ''
}

/** 十六进制转储（二进制文件预览）。 */
export async function readHex(
  root: string,
  relPath: string,
  bytes = 4096,
  signal?: AbortSignal,
): Promise<string> {
  const res = await localRequest<{ text?: string }>(
    `/local/fs/hex?${query(root, relPath)}&bytes=${bytes}`,
    signal,
  )
  return res.text ?? ''
}

/** 原始字节（图片预览），前端转成 blob URL。 */
export async function readRaw(
  root: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<Blob> {
  return localRequestBlob(`/local/fs/raw?${query(root, relPath)}`, signal)
}
