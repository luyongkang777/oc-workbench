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
import { open, readdir, realpath, stat as statFile } from 'node:fs/promises'
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

/** 行索引缓存：path -> { size, mtimeMs, index, text? } */
const cache = new Map()

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

function sendJson(res, status, body) {
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

function httpError(status, message) {
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

async function scanIndex(filePath) {
  const info = await statFile(filePath)
  const hit = cache.get(filePath)
  if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) {
    // 命中挪到最前，近似 LRU
    cache.delete(filePath)
    cache.set(filePath, hit)
    return hit.index
  }

  const fh = await open(filePath, 'r')
  try {
    const head = Buffer.alloc(4)
    const { bytesRead: headLen } = await fh.read(head, 0, 4, 0)
    const { enc, start } = detectEncoding(head.subarray(0, headLen))
    const size = info.size

    let binary = false
    if (enc === 'utf8' && size > start) {
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
        if (enc === 'utf8') {
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

    const index = { enc, size, binary, lineCount, checkpoints, start }
    cache.set(filePath, { size, mtimeMs: info.mtimeMs, index })
    if (cache.size > CACHE_CAP) {
      const oldest = cache.keys().next().value
      if (oldest && oldest !== filePath) cache.delete(oldest)
    }
    return index
  } finally {
    await fh.close()
  }
}

function decodeBuffer(buffer, enc, start = 0) {
  const body = buffer.subarray(start)
  if (enc === 'utf8') return body.toString('utf8')
  if (enc === 'utf16le') return body.toString('utf16le')
  const swapped = Buffer.from(body)
  swapped.swap16()
  return swapped.toString('utf16le')
}

async function readWholeText(filePath, index) {
  const hit = cache.get(filePath)
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

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw httpError(405, '只支持 GET')
  }
  const url = new URL(req.url, 'http://127.0.0.1')
  const action = url.pathname.split('/').pop()
  const root = url.searchParams.get('root') || ''
  const rel = url.searchParams.get('path') || ''
  const target = await resolveTarget(root, rel)
  const info = await statFile(target)

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
  const index = await scanIndex(target)

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
