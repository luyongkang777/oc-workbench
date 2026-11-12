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
/** 保存要写磁盘，慢盘上 8MB 正文 + 杀软扫描可能超过 15 秒。 */
const WRITE_TIMEOUT_MS = 60_000

function query(root: string, rel: string): string {
  return `root=${encodeURIComponent(root)}&path=${encodeURIComponent(rel)}`
}

/** 编码覆盖：「以 X 编码重新打开」时带上，空表示自动判定。 */
function withEncoding(target: string, encoding?: string | null): string {
  return encoding ? `${target}&encoding=${encodeURIComponent(encoding)}` : target
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

export type FindMatch = { path: string; type: 'file' | 'directory' }

/**
 * 按文件名（basename，大小写不敏感）在工作区里定位。
 *
 * 聊天里的工具详情常只写裸文件名（`Status.h`），而真实文件往往在 `src\` 下，
 * 直接按工作区根打开会 404；这里按名字找回真实相对路径。
 * 结果按「层级浅 → 名字小」排序，第一条通常就是想要的那个。
 */
export async function findLocal(
  root: string,
  name: string,
  signal?: AbortSignal,
): Promise<FindMatch[]> {
  const res = await localRequest<{ matches?: FindMatch[] }>(
    `/local/fs/find?root=${encodeURIComponent(root)}&name=${encodeURIComponent(name)}`,
    signal,
    30_000,
  )
  return res.matches ?? []
}

export async function statFile(
  root: string,
  relPath: string,
  encoding?: string | null,
  signal?: AbortSignal,
): Promise<FileStat> {
  return localRequest<FileStat>(
    `/local/fs/stat?${withEncoding(query(root, relPath), encoding)}`,
    signal,
    STAT_TIMEOUT_MS,
  )
}

/** 读第 start 行开始的 lines 行。 */
export async function readLines(
  root: string,
  relPath: string,
  start: number,
  lines: number,
  encoding?: string | null,
  signal?: AbortSignal,
): Promise<LineWindow> {
  const extra = `&start=${start}&lines=${lines}`
  return localRequest<LineWindow>(
    `/local/fs/read?${withEncoding(query(root, relPath), encoding)}${extra}`,
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
  encoding?: string | null,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const extra = `&q=${encodeURIComponent(keyword)}&limit=${limit}`
  return localRequest<SearchResult>(
    `/local/fs/search?${withEncoding(query(root, relPath), encoding)}${extra}`,
    signal,
    READ_TIMEOUT_MS,
  )
}

/** 整份文本（给 Markdown 预览 / 编辑器用）；超过 maxBytes 时服务端回 413。 */
export async function readText(
  root: string,
  relPath: string,
  maxBytes?: number,
  encoding?: string | null,
  signal?: AbortSignal,
): Promise<string> {
  const extra = maxBytes ? `&maxBytes=${Math.trunc(maxBytes)}` : ''
  const res = await localRequest<{ text?: string }>(
    `/local/fs/text?${withEncoding(query(root, relPath), encoding)}${extra}`,
    signal,
  )
  return res.text ?? ''
}

/** 保存后的新元信息（前端直接当新的 stat 用）。 */
export type WriteResult = {
  size: number
  mtimeMs: number
  lineCount: number
  encoding: string
}

/**
 * 整份文本保存到磁盘。
 *
 * `expectedMtimeMs` 是打开编辑器时 stat 拿到的 mtime：磁盘上的文件已被别处改过时
 * 服务端回 409，避免静默覆盖别人的修改。
 * `encoding` 决定写回用的编码（utf8 / utf16le / utf16be / gbk），不传就沿用文件原编码。
 */
export async function writeText(
  root: string,
  relPath: string,
  text: string,
  expectedMtimeMs?: number,
  encoding?: string,
  signal?: AbortSignal,
): Promise<WriteResult> {
  const extra =
    typeof expectedMtimeMs === 'number' && Number.isFinite(expectedMtimeMs)
      ? `&expectedMtimeMs=${Math.trunc(expectedMtimeMs)}`
      : ''
  const enc = encoding ? `&encoding=${encodeURIComponent(encoding)}` : ''
  const res = await localRequest<WriteResult>(
    `/local/fs/write?${query(root, relPath)}${extra}${enc}`,
    signal,
    WRITE_TIMEOUT_MS,
    {
      method: 'PUT',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: text,
    },
  )
  return res
}

/** 十六进制转储（二进制文件预览）。 */export async function readHex(
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

// ---------- 结构操作：新建文件夹 / 新建文件 / 重命名 / 删除 ----------

/** 四个结构操作都是 POST；路径相对 root，服务端负责名字校验与越界拦截。 */
async function structureOp(
  action: 'mkdir' | 'create' | 'rename' | 'delete',
  root: string,
  relPath: string,
  extra = '',
): Promise<void> {
  await localRequest<{ ok?: boolean }>(
    `/local/fs/${action}?${query(root, relPath)}${extra}`,
    undefined,
    30_000,
    { method: 'POST' },
  )
}

export function mkdirLocal(root: string, relPath: string): Promise<void> {
  return structureOp('mkdir', root, relPath)
}

export function createFileLocal(root: string, relPath: string): Promise<void> {
  return structureOp('create', root, relPath)
}

export function renameLocal(root: string, from: string, to: string): Promise<void> {
  return structureOp('rename', root, from, `&to=${encodeURIComponent(to)}`)
}

export function deleteLocal(root: string, relPath: string): Promise<void> {
  return structureOp('delete', root, relPath)
}
