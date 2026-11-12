/**
 * 从一段文本里认出「文件路径」，供聊天里的点击跳转用（纯计算，便于单测）。
 *
 * 认三种写法：
 *   `src/components/Chat.tsx`、`F:\proj\a.ts`、`./docs/x.md`（反引号/裸文本/链接都走这里）
 * 行号后缀 `:12`、`:12:5`、`#L12` 会被单独解析出来，点击后直接跳到那一行。
 *
 * 刻意不认「纯目录」（`src/components`）和没有扩展名的单词：误判比漏判更烦，
 * 点一个打不开的路径比多敲一次左栏更糟。
 */

/** 认作文件的扩展名白名单（代码/文档/配置，够覆盖日常回复）。 */
const FILE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'jsonc', 'md', 'markdown', 'mdx', 'txt', 'log', 'csv',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte', 'astro',
  'py', 'rs', 'go', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'php', 'rb', 'lua', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'sql', 'graphql', 'proto', 'lock', 'gradle', 'dockerfile',
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'pdf',
])

/** 路径长度上限：再长就当普通文本，避免把一大段 JSON 片段当路径。 */
const MAX_PATH_LEN = 300

/** 尾部会粘在路径上的标点（中英文都有）。 */
const TRAILING_PUNCT = /[\s,.;:!?，。；：！？、）)\]】》」』"'`]+$/

/**
 * 中文正文里路径常常直接粘着汉字（「改一下 src/b.ts，然后看」整段不是空白分隔的），
 * 所以边界还要认中文/全角字符：前缀剥掉、遇到就截断。
 */
const CJK_RE = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/
const LEAD_CJK_RE = /^[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/

export type FileRef = {
  /** 原始显示文本（可能带行号），点击按钮上照原样显示 */
  raw: string
  /** 交给本地文件通道的路径 */
  path: string
  /** 1 基行号 */
  line?: number
}

function stripTrailing(raw: string): string {
  return raw.replace(TRAILING_PUNCT, '')
}

/** 认不出就返回 null（调用方原样显示）。 */
export function parseFilePath(value: string | undefined | null): FileRef | null {
  if (!value) return null
  let text = value.trim().replace(/^`+|`+$/g, '')
  if (!text || text.length > MAX_PATH_LEN) return null

  // Markdown 链接里的 URL 会被转义成 %5C / %20
  if (/%[0-9a-f]{2}/i.test(text)) {
    try {
      text = decodeURIComponent(text)
    } catch {
      // 非法编码就按原样试
    }
  }
  text = stripTrailing(text)
  if (!text) return null
  if (text.includes('://')) return null

  // 行号后缀：a.ts:12 / a.ts:12:5 / a.ts#L12
  let line: number | undefined
  let path = text
  const hash = /#L(\d+)$/.exec(path)
  const colon = /:(\d+)(?::\d+)?$/.exec(path)
  if (hash) {
    line = Number(hash[1])
    path = path.slice(0, hash.index)
  } else if (colon) {
    line = Number(colon[1])
    path = path.slice(0, colon.index)
  }
  if (!path) return null

  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (!FILE_EXT.has(ext)) return null

  // 路径里出现汉字/全角符号说明切错了（正常文件名不会有）
  if (CJK_RE.test(path)) return null

  // 有盘符（F:\x）或含目录分隔符，或者就是个有名有姓的文件（package.json）
  const hasDrive = /^[a-zA-Z]:[\\/]/.test(path)
  const hasSlash = /[\\/]/.test(path)
  const bareName = /^[\w.@~+-]+\.[A-Za-z0-9]+$/.test(path)
  if (!hasDrive && !hasSlash && !bareName) return null
  // 结尾是分隔符说明这是目录
  if (/[\\/]$/.test(path)) return null

  return { raw: value.trim().replace(/^`+|`+$/g, ''), path, line }
}

export type TextChunk =
  | { kind: 'text'; text: string }
  | { kind: 'file'; ref: FileRef; text: string }

/** 在一个空白分隔的 token 里找路径（前后可能粘着汉字）。 */
function findPathInToken(token: string): { index: number; core: string; ref: FileRef } | null {
  let rest = token
  let offset = 0
  const lead = LEAD_CJK_RE.exec(rest)
  if (lead) {
    offset = lead[0].length
    rest = rest.slice(offset)
  }
  const cut = rest.search(CJK_RE)
  const raw = cut >= 0 ? rest.slice(0, cut) : rest
  const core = stripTrailing(raw)
  if (!core) return null
  const ref = parseFilePath(core)
  if (!ref) return null
  return { index: offset, core, ref }
}

/**
 * 绝对路径可能带空格（`C:\Program Files\App\a.txt`），按空白切词会把它拦腰切断。
 * 这里从起点向后找：把所有「空白 / 中文 / 全角」位置当候选终点，从最长的往回试，
 * 第一个能被 parseFilePath 认下的就是完整路径。同一段里若还有下一个绝对路径起点，
 * 就强制截在它前面，免得把两条路径连成一条。
 */
function tryAbsolutePath(text: string, start: number): { ref: FileRef; core: string } | null {
  const head = text.slice(start, start + 4)
  if (!/^(?:[a-zA-Z]:[\\/]|\/[a-zA-Z]\/)/.test(head)) return null

  let limit = Math.min(text.length, start + MAX_PATH_LEN)
  const nextAbs = /[a-zA-Z]:[\\/]|\/[a-zA-Z]\//g
  nextAbs.lastIndex = start + 3
  const next = nextAbs.exec(text)
  if (next && next.index < limit) limit = next.index

  const ends: number[] = []
  for (let i = start; i < limit; i += 1) {
    if (/\s/.test(text[i]) || CJK_RE.test(text[i])) {
      ends.push(i)
      if (ends.length >= 16) break
    }
  }
  if (ends[ends.length - 1] !== limit) ends.push(limit)

  for (let i = ends.length - 1; i >= 0; i -= 1) {
    const raw = text.slice(start, ends[i]).trim()
    if (!raw) continue
    const core = stripTrailing(raw)
    if (!core) continue
    const ref = parseFilePath(core)
    if (ref) return { ref, core }
  }
  return null
}

/**
 * 把一段纯文本切成「文字 / 文件路径」片段，保持原始顺序和空白。
 *
 * 路径边界同时认空白和中文/全角字符：`src/a.ts，然后看` 里路径在中文逗号处断开，
 * 尾随的标点也不会进路径。绝对路径额外允许内含空格（`C:\Program Files\...`）。
 */
export function splitTextPaths(text: string): TextChunk[] {
  const chunks: TextChunk[] = []
  const re = /\S+/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = re.exec(text)) !== null) {
    const tokenStart = match.index
    if (tokenStart < cursor) continue

    // 绝对路径先试：路径里可能有空格，不能按 token 切
    const abs = tryAbsolutePath(text, tokenStart)
    if (abs) {
      if (tokenStart > cursor) chunks.push({ kind: 'text', text: text.slice(cursor, tokenStart) })
      chunks.push({ kind: 'file', ref: abs.ref, text: abs.core })
      cursor = tokenStart + abs.core.length
      re.lastIndex = cursor
      continue
    }

    const found = findPathInToken(match[0])
    if (!found) continue

    const start = tokenStart + found.index
    if (start > cursor) chunks.push({ kind: 'text', text: text.slice(cursor, start) })
    chunks.push({ kind: 'file', ref: found.ref, text: found.core })
    cursor = start + found.core.length
  }

  if (cursor < text.length) chunks.push({ kind: 'text', text: text.slice(cursor) })
  return chunks
}
