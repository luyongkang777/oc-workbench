// Vite dev server 的本地文件中间件：接口与 Rust 外壳的 `/local/fs/*` 对齐。
//
// 生产走 `shell/src/fsapi.rs`（直接读磁盘、稀疏检查点分页）；dev 没有外壳，
// 这里用 Node 实现同一套语义，方便在浏览器里验证大文件/虚拟滚动。
//
// 已知差异（docs/api-notes.md §9 有记录）：
//   * dev 不做 token 校验（只监听 loopback，且只用于开发）；
//   * UTF-16 大文件（>64MB）dev 直接 413，生产仍可分页；
//   * dev 的页读是「解码后按行切」，不保证与 Rust 完全相同的字节边界，
//     但 `{text,next,eof,lineCount}` 的形状与续拉语义一致。
//
// 只在 `npm run dev` 生效，打包产物不包含它。

import { createReadStream } from 'node:fs'
import {
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat as statFile,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

const WINDOW_LINES_DEFAULT = 200
const WINDOW_LINES_MAX = 1000
const MAX_WINDOW_BYTES = 512 * 1024
const MAX_LINE_BYTES = 256 * 1024
const TEXT_DEFAULT_MAX = 1024 * 1024
const TEXT_HARD_MAX = 4 * 1024 * 1024
const HEX_MAX = 64 * 1024
const DEV_UTF16_MAX = 64 * 1024 * 1024
const CACHE_CAP = 8
/** 单次保存的正文上限，与 Rust 外壳保持一致。 */
const WRITE_MAX_BYTES = 8 * 1024 * 1024

// ---------- 按文件名定位（/local/fs/find）----------
// 聊天里的工具详情常常只写裸文件名（`Status.h`、`Protocol.h`），点开时按工作区根去找
// 必然 404（真实文件在 src\ 下）。前端因此会二次询问「这个文件名在哪」。
/** 搜索时跳过的重目录：和文件树的隐藏规则保持一致。 */
const FIND_SKIP = new Set(['node_modules', '.git', 'dist', 'target', '.vite', '.vite-temp', '.cache'])
const FIND_MAX_DEPTH = 8
const FIND_MAX_VISITS = 20000
const FIND_MAX_MATCHES = 50

// ---------- 保存（PUT /local/fs/write）用的小工具 ----------

/** 读完整个请求体；超限直接 413，不把内存吃光。 */
export async function readBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw httpError(413, '文件太大，单次保存上限 8MB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** 同目录临时文件 + rename：写一半失败不会把原文件截断。 */
export async function writeFileAtomic(file, bytes) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.ocwb-${process.pid}.tmp`)
  await writeFile(tmp, bytes)
  try {
    await rename(tmp, file)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

/** 原文件是否带 BOM、是否用 CRLF（按原编码解码前 64KB 判断）。 */
export async function detectWriteStyle(file, index) {
  const bom =
    (index.enc === 'utf8' && index.start === 3) ||
    ((index.enc === 'utf16le' || index.enc === 'utf16be') && index.start === 2)
  const fh = await open(file, 'r')
  try {
    const head = Buffer.alloc(64 * 1024)
    const { bytesRead } = await fh.read(head, 0, head.length, index.start)
    const text = decodeBuffer(head.subarray(0, bytesRead), index.enc)
    return { bom, crlf: text.includes('\r\n') }
  } finally {
    await fh.close()
  }
}

/**
 * GB18030 反查表：Node 只给了解码器，编码表得从解码器反推。
 * 首次保存 GBK 时建一次（约 2.4 万对），之后复用。
 */
let gbkTable = null
function gbkEncodeMap() {
  if (gbkTable) return gbkTable
  const decoder = new TextDecoder('gb18030')
  const map = new Map()
  const pair = Buffer.alloc(2)
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue
      pair[0] = lead
      pair[1] = trail
      const char = decoder.decode(pair)
      if (char.length === 1 && char !== '\uFFFD' && !map.has(char)) map.set(char, [lead, trail])
    }
  }
  gbkTable = map
  return map
}

function encodeGbk(text) {
  const map = gbkEncodeMap()
  const out = []
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code < 0x80) {
      out.push(code)
      continue
    }
    const bytes = map.get(char)
    if (!bytes) {
      throw httpError(
        400,
        '文本含有 GBK 无法表示的字符（dev 不支持 GB18030 四字节字符），请改用 UTF-8 保存',
      )
    }
    out.push(bytes[0], bytes[1])
  }
  return Buffer.from(out)
}

/** 与 Rust `encode_text` 同语义：归一到 \n → 按文件风格还原换行 → 按目标编码落字节。 */
export function encodeText(text, enc, bom, crlf) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const body = crlf ? normalized.replace(/\n/g, '\r\n') : normalized
  if (enc === 'gbk') return encodeGbk(body)
  if (enc === 'utf16le' || enc === 'utf16be') {
    const payload = Buffer.from(body, 'utf16le')
    if (enc === 'utf16be') payload.swap16()
    return Buffer.concat([
      Buffer.from(enc === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]),
      payload,
    ])
  }
  const payload = Buffer.from(body, 'utf8')
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), payload]) : payload
}

/** 行数口径与行索引一致：`"a\nb\n"` 是 2 行，空文件 0 行。 */
export function countLines(text) {
  if (text === '') return 0
  let newlines = 0
  for (const byte of Buffer.from(text, 'utf8')) if (byte === 0x0a) newlines += 1
  return text.endsWith('\n') ? newlines : newlines + 1
}

export function decodeUtf8Strict(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw httpError(400, '请求体不是合法的 UTF-8 文本')
  }
}

/** 查询参数里的编码名 → 内部名；认不出来返回 null。 */
export function normalizeEncoding(name) {
  switch (String(name || '').trim().toLowerCase()) {
    case 'utf8':
    case 'utf-8':
      return 'utf8'
    case 'utf16le':
    case 'utf-16le':
    case 'utf16':
      return 'utf16le'
    case 'utf16be':
    case 'utf-16be':
      return 'utf16be'
    case 'gbk':
    case 'gb2312':
    case 'gb18030':
      return 'gbk'
    default:
      return null
  }
}

/** 行索引缓存：path -> { size, mtimeMs, index, text? } */
const cache = new Map()

/** 文件写过之后：把「路径」和「路径#编码」的所有索引变体一起清掉。 */
function invalidate(filePath) {
  for (const key of [...cache.keys()]) {
    if (key === filePath || key.startsWith(`${filePath}#`)) cache.delete(key)
  }
}

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

/** 写 JSON 响应；头已经发出去就断开连接，别在半截响应上再拼一段。 */
export function sendJson(res, status, body) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/** 带 HTTP 状态的错误：中间件统一 catch 后按 status 回 `{ error, status }`。 */
export function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

function intParam(params, name, fallback) {
  const raw = params.get(name)
  if (raw === null) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? Math.trunc(value) : fallback
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

async function resolveTarget(root, rel) {
  if (!root) throw httpError(400, '缺少 root 参数')
  const rootReal = await realpath(root).catch(() => {
    throw httpError(404, `目录不存在：${root}`)
  })
  const rootInfo = await statFile(rootReal).catch(() => null)
  if (!rootInfo || !rootInfo.isDirectory()) throw httpError(400, 'root 不是目录')

  // 先逐段校验，再拼路径：顺序反过来就可能先 realpath 到 root 外面。
  const parts = rel.split(/[\\/]+/).filter((part) => part && part !== '.')
  for (const part of parts) {
    if (part === '..') throw httpError(400, '路径不允许包含 ..')
    if (part.includes(':')) throw httpError(400, '路径不允许包含盘符')
  }
  const target = await realpath(path.join(rootReal, ...parts)).catch(() => {
    throw httpError(404, `文件不存在：${rel}`)
  })
  const relative = path.relative(rootReal, target)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw httpError(403, '路径越界')
  }
  return target
}

function detectEncoding(head) {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { enc: 'utf8', start: 3 }
  if (head[0] === 0xff && head[1] === 0xfe) return { enc: 'utf16le', start: 2 }
  if (head[0] === 0xfe && head[1] === 0xff) return { enc: 'utf16be', start: 2 }
  return { enc: 'utf8', start: 0 }
}

/** 允许「末尾正好切在多字节字符中间」的 UTF-8 判断。 */
function isUtf8Prefix(bytes) {
  for (let trim = 0; trim <= 3 && trim < bytes.length; trim += 1) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.length - trim))
      return true
    } catch {
      // 继续多裁一个字节再试
    }
  }
  return false
}

/** 严格按 GB18030 解码一次，用来区分「GBK 正文」和「谁都解不了的二进制」。 */
function isValidGbk(bytes) {
  try {
    new TextDecoder('gb18030', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

async function scanIndex(filePath, forcedEnc = null) {
  const info = await statFile(filePath)
  // 缓存键带上强制编码：同一文件按不同编码扫出来的行布局可能不同
  const key = forcedEnc ? `${filePath}#${forcedEnc}` : filePath
  const hit = cache.get(key)
  if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) {
    // 命中挪到最前，近似 LRU
    cache.delete(key)
    cache.set(key, hit)
    return hit.index
  }

  const fh = await open(filePath, 'r')
  try {
    const head = Buffer.alloc(4)
    const { bytesRead: headLen } = await fh.read(head, 0, 4, 0)
    let { enc, start } = detectEncoding(head.subarray(0, headLen))
    const size = info.size

    if (forcedEnc) {
      // 强制编码：BOM 与它一致时才跳过 BOM，否则从 0 开始
      if (enc !== forcedEnc) start = 0
      enc = forcedEnc
    } else if (enc === 'utf8' && start === 0 && size > 0) {
      // 没有 BOM：先用前 8KB 试 UTF-8，不是合法 UTF-8 再试 GB18030（与 Rust 外壳一致）
      const probe = Buffer.alloc(Math.min(8192, size))
      const { bytesRead } = await fh.read(probe, 0, probe.length, 0)
      const bytes = probe.subarray(0, bytesRead)
      if (!isUtf8Prefix(bytes) && isValidGbk(bytes)) enc = 'gbk'
    }

    let binary = false
    if (enc === 'utf8' || enc === 'gbk') {
      const probe = Buffer.alloc(Math.min(8192, size - start))
      const { bytesRead } = await fh.read(probe, 0, probe.length, start)
      binary = probe.subarray(0, bytesRead).includes(0)
    }

    let lineCount = 0
    const checkpoints = [[0, start]]
    if (!binary) {
      const chunk = Buffer.alloc(1024 * 1024) // 偶数长度，UTF-16 配对始终对齐
      let position = start
      let newlines = 0
      let lastIsNewline = false
      while (true) {
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, position)
        if (bytesRead === 0) break
        if (enc === 'utf8' || enc === 'gbk') {
          for (let i = 0; i < bytesRead; i += 1) {
            lastIsNewline = chunk[i] === 0x0a
            if (!lastIsNewline) continue
            newlines += 1
            if (newlines % 4096 === 0) checkpoints.push([newlines, position + i + 1])
          }
        } else {
          for (let i = 0; i + 1 < bytesRead; i += 2) {
            const unit = enc === 'utf16le' ? chunk.readUInt16LE(i) : chunk.readUInt16BE(i)
            lastIsNewline = unit === 0x0a
            if (!lastIsNewline) continue
            newlines += 1
            if (newlines % 4096 === 0) checkpoints.push([newlines, position + i + 2])
          }
        }
        position += bytesRead
      }
      lineCount = newlines
      if (size > start && !lastIsNewline) lineCount += 1
    }

    const index = { key, enc, size, binary, lineCount, checkpoints, start }
    cache.set(key, { size, mtimeMs: info.mtimeMs, index })
    if (cache.size > CACHE_CAP) {
      const oldest = cache.keys().next().value
      if (oldest && oldest !== key) cache.delete(oldest)
    }
    return index
  } finally {
    await fh.close()
  }
}

function decodeBuffer(buffer, enc, start = 0) {
  const body = buffer.subarray(start)
  if (enc === 'utf8') return body.toString('utf8')
  if (enc === 'gbk') return new TextDecoder('gb18030').decode(body)
  if (enc === 'utf16le') return body.toString('utf16le')
  const swapped = Buffer.from(body)
  swapped.swap16()
  return swapped.toString('utf16le')
}

async function readWholeText(filePath, index) {
  const hit = cache.get(index.key)
  if (hit?.text) return hit.text
  if (index.size > DEV_UTF16_MAX) {
    throw httpError(413, 'dev 模式下的 UTF-16 大文件暂不支持，请用打包后的 exe')
  }
  const fh = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(index.size)
    const { bytesRead } = await fh.read(buffer, 0, index.size, 0)
    const text = decodeBuffer(buffer.subarray(0, bytesRead), index.enc, index.start).replace(
      /\r\n/g,
      '\n',
    )
    if (hit) hit.text = text
    return text
  } finally {
    await fh.close()
  }
}

function clipLine(line) {
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES) return line
  // 截断到 256KB 字节；末尾半个多字节字符由 toString 的替换字符兜住
  return Buffer.from(line, 'utf8').subarray(0, MAX_LINE_BYTES).toString('utf8')
}

async function readWindow(filePath, index, start, lines) {
  if (index.binary || start >= index.lineCount) {
    return { start, text: '', next: Math.max(index.lineCount, start), eof: true }
  }
  if (index.enc !== 'utf8') {
    const all = (await readWholeText(filePath, index)).split('\n')
    const slice = all.slice(start, start + lines).map(clipLine)
    const next = start + slice.length
    return { start, text: slice.join('\n'), next, eof: next >= index.lineCount }
  }

  let checkpoint = [0, index.start]
  for (const point of index.checkpoints) {
    if (point[0] > start) break
    checkpoint = point
  }

  const stream = createReadStream(filePath, { start: checkpoint[1], encoding: 'utf8' })
  const reader = stream[Symbol.asyncIterator]()
  let buffer = ''
  let skipped = 0
  let lineNo = checkpoint[0]
  const collected = []
  let bytes = 0
  let hitEof = false

  const nextLine = async () => {
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        return line
      }
      const chunk = await reader.next()
      if (chunk.done) {
        if (buffer.length === 0) return null
        const line = buffer.replace(/\r$/, '')
        buffer = ''
        return line
      }
      buffer += chunk.value
    }
  }

  while (skipped < start - checkpoint[0]) {
    const line = await nextLine()
    if (line === null) {
      hitEof = true
      break
    }
    skipped += 1
    lineNo += 1
  }

  while (collected.length < lines && lineNo < index.lineCount) {
    const line = await nextLine()
    if (line === null) {
      hitEof = true
      break
    }
    const clipped = clipLine(line)
    collected.push(clipped)
    bytes += Buffer.byteLength(clipped, 'utf8') + 1
    lineNo += 1
    if (bytes >= MAX_WINDOW_BYTES) break
  }
  stream.destroy()

  const next = start + collected.length
  return { start, text: collected.join('\n'), next, eof: next >= index.lineCount || hitEof }
}

function hexDump(buffer, offset) {
  const lines = []
  for (let row = 0; row < buffer.length; row += 16) {
    const chunk = buffer.subarray(row, row + 16)
    let hex = ''
    for (let i = 0; i < 16; i += 1) {
      hex += i < chunk.length ? `${chunk[i].toString(16).padStart(2, '0')} ` : '   '
      if (i === 7) hex += ' '
    }
    let ascii = ''
    for (const byte of chunk) ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'
    lines.push(`${(offset + row).toString(16).padStart(8, '0')}  ${hex} |${ascii}|`)
  }
  return lines.length ? lines.join('\n') + '\n' : ''
}

/** 结构操作：新建目录 / 新建文件 / 重命名 / 删除（目标可能还不存在）。 */
const STRUCTURE_ACTIONS = new Set(['mkdir', 'create', 'rename', 'delete'])
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

function validateName(name) {
  if (!name) throw httpError(400, '名字不能为空')
  if (name === '.' || name === '..') throw httpError(400, '名字不能是 . 或 ..')
  if ([...name].length > 200) throw httpError(400, '名字太长')
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) {
    throw httpError(400, '名字不能包含 <>:"/\\|?* 或控制字符')
  }
  if (/[ .]$/.test(name)) throw httpError(400, '名字不能以空格或点结尾')
  const stem = name.split('.')[0].toUpperCase()
  if (RESERVED_NAMES.has(stem)) throw httpError(400, '这是 Windows 保留名字，换一个')
}

/** 解析「还不存在」的目标：父目录必须存在且落在 root 内。 */
async function resolveNew(root, rel) {
  if (!root) throw httpError(400, '缺少 root 参数')
  const rootReal = await realpath(root).catch(() => {
    throw httpError(404, `目录不存在：${root}`)
  })
  const parts = rel.split(/[\\/]+/).filter((part) => part && part !== '.')
  const name = parts.pop()
  if (!name) throw httpError(400, '路径不能为空')
  validateName(name)
  for (const part of parts) {
    if (part === '..') throw httpError(400, '路径不允许包含 ..')
    if (part.includes(':')) throw httpError(400, '路径不允许包含盘符')
  }
  const parent = await realpath(path.join(rootReal, ...parts)).catch(() => {
    throw httpError(404, `父目录不存在：${rel}`)
  })
  const relative = path.relative(rootReal, parent)
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw httpError(403, '路径越界')
  }
  return path.join(parent, name)
}

async function fsOps(req, action, root, rel, url) {
  if ((req.method || 'GET') !== 'POST') throw httpError(405, '这个接口只支持 POST')

  if (action === 'mkdir') {
    const target = await resolveNew(root, rel)
    await mkdir(target).catch((err) => {
      if (err.code === 'EEXIST') throw httpError(409, '同名文件或文件夹已存在')
      throw err
    })
  } else if (action === 'create') {
    const target = await resolveNew(root, rel)
    const handle = await open(target, 'wx').catch((err) => {
      if (err.code === 'EEXIST') throw httpError(409, '同名文件或文件夹已存在')
      throw err
    })
    await handle.close()
  } else if (action === 'rename') {
    const to = (url.searchParams.get('to') || '').trim()
    if (!rel.trim() || !to) throw httpError(400, '路径不能为空')
    const source = await resolveTarget(root, rel)
    const destination = await resolveNew(root, to)
    const taken = await statFile(destination).then(
      () => true,
      () => false,
    )
    if (taken) throw httpError(409, '目标名字已被占用')
    await rename(source, destination)
    invalidate(source)
    invalidate(destination)
  } else if (action === 'delete') {
    if (!rel.trim()) throw httpError(400, '不能删除根目录')
    const source = await resolveTarget(root, rel)
    const rootReal = await realpath(root).catch(() => '')
    if (rootReal && source === rootReal) throw httpError(400, '不能删除根目录')
    await rm(source, { recursive: true, force: false })
    invalidate(source)
  } else {
    throw httpError(404, '未知的结构操作')
  }
  return { ok: true, path: rel }
}

/**
 * 按文件名（basename，大小写不敏感）在工作区里找文件。
 *
 * 返回的 path 是相对 root 的路径（反斜杠分隔），按「层级浅的、名字小的」排前面：
 * 顶层同名文件优先于深层同名文件，前端取第一条即可。
 */
async function findByName(root, name) {
  if (!root) throw httpError(400, '缺少 root 参数')
  const rootReal = await realpath(root).catch(() => {
    throw httpError(404, `目录不存在：${root}`)
  })
  const needle = name.toLowerCase()
  const matches = []
  let visits = 0

  const walk = async (dirAbs, rel, depth) => {
    if (matches.length >= FIND_MAX_MATCHES || visits >= FIND_MAX_VISITS || depth > FIND_MAX_DEPTH) return
    let entries
    try {
      entries = await readdir(dirAbs, { withFileTypes: true })
    } catch {
      // 权限/占用导致的读不到，跳过这个目录，不影响其它分支
      return
    }
    visits += entries.length
    for (const entry of entries) {
      if (matches.length >= FIND_MAX_MATCHES || visits >= FIND_MAX_VISITS) return
      const childRel = rel ? `${rel}\\${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (FIND_SKIP.has(entry.name)) continue
        await walk(path.join(dirAbs, entry.name), childRel, depth + 1)
        continue
      }
      if (entry.name.toLowerCase() === needle) matches.push({ path: childRel, type: 'file' })
    }
  }

  await walk(rootReal, '', 0)
  matches.sort((a, b) => {
    const da = a.path.split('\\').length
    const db = b.path.split('\\').length
    if (da !== db) return da - db
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })
  return { matches }
}

async function handle(req, res) {
  const method = req.method || 'GET'
  if (method !== 'GET' && method !== 'HEAD' && method !== 'PUT' && method !== 'POST') {
    throw httpError(405, '只支持 GET / PUT / POST')
  }
  const url = new URL(req.url, 'http://127.0.0.1')
  const action = url.pathname.split('/').pop()
  const root = url.searchParams.get('root') || ''
  const rel = url.searchParams.get('path') || ''

  // 结构操作：目标可能还不存在，不能走 resolveTarget
  if (STRUCTURE_ACTIONS.has(action)) {
    const result = await fsOps(req, action, root, rel, url)
    return sendJson(res, 200, result)
  }

  // 按文件名在工作区里定位（裸文件名打开失败时用）
  if (action === 'find') {
    const name = (url.searchParams.get('name') || rel || '').trim()
    if (!name) throw httpError(400, '缺少 name 参数')
    return sendJson(res, 200, await findByName(root, name))
  }

  const target = await resolveTarget(root, rel)
  const info = await statFile(target)

  // encoding 参数：GET 系列表示「按这个编码解」，write 表示「按这个编码写」，不传就自动/沿用
  const encodingParam = (url.searchParams.get('encoding') || '').trim()
  const forcedEnc = encodingParam ? normalizeEncoding(encodingParam) : null
  if (encodingParam && !forcedEnc) throw httpError(400, `不认识的编码：${encodingParam}`)

  // 唯一的写接口：整份文本原子落盘，风格（BOM / CRLF）沿用原文件；可用 encoding 改编码保存。
  if (action === 'write') {
    if (method !== 'PUT') throw httpError(405, '保存只支持 PUT')
    if (info.isDirectory()) throw httpError(400, '这是目录，不是文件')
    const index = await scanIndex(target)
    if (index.binary) throw httpError(415, '二进制文件不支持编辑')

    const expected = url.searchParams.get('expectedMtimeMs')
    if (expected !== null && Number(expected) !== Math.trunc(info.mtimeMs)) {
      throw httpError(409, '文件已在磁盘上被修改，请重新加载后再保存')
    }

    const targetEnc = forcedEnc || index.enc

    const text = decodeUtf8Strict(await readBody(req, WRITE_MAX_BYTES))
    const style = await detectWriteStyle(target, index)
    // 换编码保存时不沿用原 BOM；UTF-16 由 encodeText 自己补 BOM
    const bom = targetEnc === index.enc ? style.bom : false
    await writeFileAtomic(target, encodeText(text, targetEnc, bom, style.crlf))
    // 索引按「路径 + 编码」缓存，这里把所有变体一起清掉，避免同毫秒写入时拿到旧索引。
    invalidate(target)
    const after = await statFile(target)
    return sendJson(res, 200, {
      size: after.size,
      mtimeMs: after.mtimeMs,
      lineCount: countLines(text),
      encoding: targetEnc,
    })
  }

  if (method !== 'GET' && method !== 'HEAD') throw httpError(405, '只有 write 支持 PUT')

  if (action === 'list') {
    if (!info.isDirectory()) throw httpError(400, '这不是目录')
    const entries = await readdir(target, { withFileTypes: true })
    const rows = []
    for (const entry of entries) {
      const isDir = entry.isDirectory()
      const childRel = rel ? `${rel.replace(/[\\/]+$/, '')}\\${entry.name}` : entry.name
      const childPath = isDir ? `${childRel}\\` : childRel
      let size = null
      if (!isDir) {
        size = await statFile(path.join(target, entry.name)).then((stat) => stat.size).catch(() => null)
      }
      rows.push({ path: childPath, type: isDir ? 'directory' : 'file', size })
    }
    rows.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      const left = a.path.toLowerCase()
      const right = b.path.toLowerCase()
      return left < right ? -1 : left > right ? 1 : 0
    })
    return sendJson(res, 200, { entries: rows })
  }

  if (info.isDirectory()) throw httpError(400, '这是目录，不是文件')
  const index = await scanIndex(target, forcedEnc)

  if (action === 'search') {
    if (index.binary) throw httpError(415, '二进制文件不支持文本搜索')
    const keyword = (url.searchParams.get('q') || '').trim()
    if (!keyword) throw httpError(400, '缺少搜索关键词 q')
    if ([...keyword].length > 256) throw httpError(400, '搜索关键词过长')
    const limit = clamp(intParam(url.searchParams, 'limit', 200), 1, 1000)
    const from = Math.max(0, intParam(url.searchParams, 'from', 0))
    const caseSensitive = url.searchParams.get('case') === '1'
    const needle = caseSensitive ? keyword : keyword.toLowerCase()

    let start = from
    const matches = []
    let truncated = false
    while (start < index.lineCount) {
      const window = await readWindow(target, index, start, 1000)
      const count = Math.max(0, window.next - start)
      if (count === 0) break
      const lines =
        window.text === '' ? new Array(count).fill('') : window.text.split(String.fromCharCode(10))
      while (lines.length < count) lines.push('')
      for (let i = 0; i < count; i += 1) {
        const line = lines[i] ?? ''
        const hay = caseSensitive ? line : line.toLowerCase()
        if (!hay.includes(needle)) continue
        matches.push({ line: start + i, text: line.trim().slice(0, 240) })
        if (matches.length >= limit) {
          truncated = true
          break
        }
      }
      if (truncated || window.eof) break
      const next = Math.max(window.next, start + 1)
      if (next <= start) break
      start = next
    }
    return sendJson(res, 200, { matches, truncated, lineCount: index.lineCount })
  }

  if (action === 'stat') {
    return sendJson(res, 200, {
      size: index.size,
      mtimeMs: info.mtimeMs,
      lineCount: index.lineCount,
      encoding: index.enc,
      binary: index.binary,
    })
  }

  if (action === 'read') {
    if (index.binary) throw httpError(415, '二进制文件，无法按文本预览')
    const start = Math.max(0, intParam(url.searchParams, 'start', 0))
    const lines = clamp(intParam(url.searchParams, 'lines', WINDOW_LINES_DEFAULT), 1, WINDOW_LINES_MAX)
    const window = await readWindow(target, index, start, lines)
    return sendJson(res, 200, { ...window, lineCount: index.lineCount })
  }

  if (action === 'text') {
    if (index.binary) throw httpError(415, '二进制文件，无法按文本预览')
    const max = clamp(intParam(url.searchParams, 'maxBytes', TEXT_DEFAULT_MAX), 64 * 1024, TEXT_HARD_MAX)
    if (index.size > max) throw httpError(413, '文件太大，全文预览请改用分页阅读')
    return sendJson(res, 200, { text: await readWholeText(target, index) })
  }

  if (action === 'raw') {
    const ext = path.extname(target).slice(1).toLowerCase()
    res.statusCode = 200
    res.setHeader('content-type', MIME[ext] || 'application/octet-stream')
    res.setHeader('cache-control', 'no-store')
    const stream = createReadStream(target)
    stream.on('error', () => {
      if (res.headersSent) res.destroy()
      else sendJson(res, 500, { error: '读取失败', status: 500 })
    })
    res.on('close', () => stream.destroy())
    stream.pipe(res)
    return
  }

  if (action === 'hex') {
    const offset = Math.max(0, intParam(url.searchParams, 'offset', 0))
    const bytes = clamp(intParam(url.searchParams, 'bytes', 4096), 16, HEX_MAX)
    const want = Math.max(0, Math.min(bytes, index.size - offset))
    const fh = await open(target, 'r')
    try {
      const buffer = Buffer.alloc(want)
      const { bytesRead } = await fh.read(buffer, 0, want, offset)
      return sendJson(res, 200, { text: hexDump(buffer.subarray(0, bytesRead), offset) })
    } finally {
      await fh.close()
    }
  }

  throw httpError(404, '未知的本地文件接口')
}

/** 只拦截 `/local` 与 `/local/`，其余请求原样交给 Vite。 */
export function localFsPlugin() {
  return {
    name: 'oc-workbench-local-fs',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || (req.url !== '/local' && !req.url.startsWith('/local/'))) {
          next()
          return
        }
        handle(req, res).catch((err) => {
          const status = err.status || (err.code === 'ENOENT' ? 404 : 500)
          const message = err.status ? err.message : `本地读取失败（${err.code || 'unknown'}）`
          sendJson(res, status, { error: message, status })
        })
      })
    },
  }
}
