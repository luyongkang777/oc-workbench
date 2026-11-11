// 代码补全的纯逻辑：识别补全上下文、抽当前文件符号、排序、写回文本。
//
// 不碰 DOM / 网络 / React，node 直接测（scripts/completion.test.mjs）。
// 目标是「写完就能用」，不依赖语言服务器：当前文件符号 + 同目录跨文件符号 +
// 语言关键字 + import 路径，覆盖日常写代码时最常按 Tab 的那一下。

export type Lang =
  | 'ts'
  | 'js'
  | 'python'
  | 'rust'
  | 'go'
  | 'json'
  | 'css'
  | 'html'
  | 'shell'
  | 'sql'
  | 'c'
  | 'markdown'
  | 'text'

export type CompletionMode = 'word' | 'member' | 'path'

export type CompletionContext = {
  mode: CompletionMode
  /** 要被替换的区间起点（含） */
  start: number
  /** 区间终点（光标） */
  end: number
  /** 已经打出来的前缀 */
  prefix: string
  /** path 模式下当前字符串的引号 */
  quote?: string
}

export type SymbolKind = 'function' | 'class' | 'variable' | 'type' | 'import'

export type SymbolInfo = { name: string; kind: SymbolKind; line: number }

export type CandidateKind = 'keyword' | 'local' | 'workspace' | 'member' | 'path'

export type Candidate = {
  label: string
  /** 实际插入的文本，默认等于 label */
  insert?: string
  kind: CandidateKind
  detail?: string
  /** 内部排序分，不展示 */
  score?: number
}

const EXT_LANG: Record<string, Lang> = {
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  py: 'python',
  pyw: 'python',
  rs: 'rust',
  go: 'go',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  vue: 'html',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'shell',
  sql: 'sql',
  c: 'c',
  h: 'c',
  cc: 'c',
  cpp: 'c',
  hpp: 'c',
  cs: 'c',
  md: 'markdown',
  markdown: 'markdown',
}

/** 按路径判断语言；不认识的当纯文本（只给单词补全）。 */
export function languageOf(path: string): Lang {
  const name = String(path ?? '').replace(/\\/g, '/')
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot < 0) return 'text'
  return EXT_LANG[base.slice(dot + 1).toLowerCase()] ?? 'text'
}

/** 支持补全的语言（后面用来决定要不要开索引）。 */
export function isCodeLang(lang: Lang): boolean {
  return lang !== 'markdown' && lang !== 'text'
}

const KEYWORDS: Record<Lang, string[]> = {
  ts: [
    'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete',
    'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get',
    'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'keyof', 'let', 'new', 'null',
    'of', 'private', 'protected', 'public', 'readonly', 'return', 'set', 'static', 'super', 'switch',
    'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'yield',
  ],
  js: [
    'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete',
    'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import',
    'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'super', 'switch', 'this', 'throw',
    'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'yield',
  ],
  python: [
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
    'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
    'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while',
    'with', 'yield', 'self', 'print', 'len', 'range', 'str', 'int', 'float', 'dict', 'list', 'set',
  ],
  rust: [
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern',
    'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub',
    'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe',
    'use', 'where', 'while', 'Some', 'None', 'Ok', 'Err', 'String', 'Vec', 'Option', 'Result',
  ],
  go: [
    'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for',
    'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select',
    'struct', 'switch', 'type', 'var', 'nil', 'true', 'false', 'string', 'int', 'error',
  ],
  json: ['true', 'false', 'null'],
  css: [
    'display', 'flex', 'grid', 'block', 'inline', 'none', 'absolute', 'relative', 'fixed', 'sticky',
    'color', 'background', 'border', 'padding', 'margin', 'width', 'height', 'font-size', 'font-weight',
    'position', 'top', 'left', 'right', 'bottom', 'overflow', 'opacity', 'transform', 'transition',
  ],
  html: [
    'div', 'span', 'section', 'header', 'footer', 'main', 'nav', 'button', 'input', 'textarea',
    'label', 'form', 'table', 'tr', 'td', 'th', 'ul', 'li', 'ol', 'a', 'img', 'script', 'style',
    'class', 'id', 'href', 'src', 'type', 'value', 'onClick', 'className',
  ],
  shell: [
    'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac',
    'function', 'echo', 'export', 'local', 'readonly', 'set', 'shift', 'return', 'exit',
  ],
  sql: [
    'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'JOIN',
    'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
    'CREATE', 'TABLE', 'INDEX', 'ALTER', 'DROP', 'AND', 'OR', 'NOT', 'NULL', 'AS', 'DISTINCT',
  ],
  c: [
    'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
    'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'return', 'short',
    'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void',
    'volatile', 'while', 'class', 'namespace', 'public', 'private', 'protected', 'template',
    'typename', 'using', 'nullptr', 'true', 'false',
  ],
  markdown: [],
  text: [],
}

export function keywordList(lang: Lang): string[] {
  return KEYWORDS[lang] ?? []
}

// ---------------------------------------------------------------- 上下文

const IDENT_RE = /[\p{L}\p{N}_$]/u

export function isIdentChar(ch: string): boolean {
  return !!ch && IDENT_RE.test(ch)
}

/**
 * 判断光标处该补什么。
 *
 * - 在字符串里且看起来像路径 → path（补文件名 / 目录）
 * - 前面紧挨着 `.` → member（成员访问，前缀可以为空）
 * - 其余在标识符上 → word
 */
export function readContext(text: string, pos: number): CompletionContext {
  const caret = Math.max(0, Math.min(pos, text.length))
  const str = stringAt(text, caret)
  if (str) {
    return { mode: 'path', start: str.contentStart, end: caret, prefix: text.slice(str.contentStart, caret), quote: str.quote }
  }

  let start = caret
  while (start > 0 && isIdentChar(text[start - 1])) start -= 1
  const before = start > 0 ? text[start - 1] : ''
  return {
    mode: before === '.' ? 'member' : 'word',
    start,
    end: caret,
    prefix: text.slice(start, caret),
  }
}

/**
 * 光标是否在单行字符串里。
 * 只看当前行：跨行模板字符串在这个编辑器里补全价值不高，按行判断更稳也不会被
 * 上一个字符串里的引号带跑。
 */
function stringAt(text: string, caret: number): { quote: string; contentStart: number } | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  let quote = ''
  let quoteAt = -1
  for (let i = lineStart; i < caret; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      quoteAt = i
      continue
    }
    // 行注释之后的东西不参与补全
    if (ch === '/' && text[i + 1] === '/') return null
    if (ch === '#') return null
  }
  if (!quote || quoteAt < 0) return null
  return { quote, contentStart: quoteAt + 1 }
}

/** 自动弹补全的条件；手动触发（Ctrl+Space）不看这个。 */
export function shouldAutoTrigger(prevChar: string, ctx: CompletionContext): boolean {
  if (ctx.mode === 'path') return ctx.prefix.startsWith('.') || ctx.prefix.includes('/')
  if (ctx.mode === 'member') return prevChar === '.'
  if (!ctx.prefix) return false
  // 打第一个字符就弹；数字开头只在后面出现过字母时弹（避免 12 触发一堆）
  return /[\p{L}_$]/u.test(ctx.prefix[0])
}

// ---------------------------------------------------------------- 抽符号

const TS_PATTERNS: Array<[RegExp, SymbolKind]> = [
  [/\b(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g, 'function'],
  [/\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g, 'class'],
  [/\b(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g, 'type'],
  [/\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::|=)/g, 'variable'],
]

const PY_PATTERNS: Array<[RegExp, SymbolKind]> = [
  [/^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, 'function'],
  [/^[ \t]*class\s+([A-Za-z_]\w*)/gm, 'class'],
  [/^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=/gm, 'variable'],
]

const RS_PATTERNS: Array<[RegExp, SymbolKind]> = [
  [/\bfn\s+([A-Za-z_]\w*)/g, 'function'],
  [/\b(?:struct|enum|trait|union)\s+([A-Za-z_]\w*)/g, 'type'],
  [/\b(?:const|static)\s+([A-Z][A-Z0-9_]*)/g, 'variable'],
  [/\blet\s+(?:mut\s+)?([A-Za-z_]\w*)/g, 'variable'],
]

const GO_PATTERNS: Array<[RegExp, SymbolKind]> = [
  [/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g, 'function'],
  [/\btype\s+([A-Za-z_]\w*)/g, 'type'],
  [/\b(?:const|var)\s+([A-Za-z_]\w*)/g, 'variable'],
]

const C_PATTERNS: Array<[RegExp, SymbolKind]> = [
  [/\b(?:typedef\s+)?struct\s+([A-Za-z_]\w*)/g, 'type'],
  [/\btypedef\s+\w+\s+([A-Za-z_]\w*)\s*;/g, 'type'],
  [/\b(?:class|namespace)\s+([A-Za-z_]\w*)/g, 'type'],
  [/\b(?:[A-Za-z_]\w*[\s*&]+)+([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{/g, 'function'],
]

const SHELL_PATTERNS: Array<[RegExp, SymbolKind]> = [
  [/^[ \t]*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/gm, 'function'],
  [/^[ \t]*([A-Z_][A-Z0-9_]*)=/gm, 'variable'],
]

const SQL_PATTERNS: Array<[RegExp, SymbolKind]> = [
  [/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w.]*)/gi, 'type'],
]

function patternsFor(lang: Lang): Array<[RegExp, SymbolKind]> {
  switch (lang) {
    case 'ts':
    case 'js':
      return TS_PATTERNS
    case 'python':
      return PY_PATTERNS
    case 'rust':
      return RS_PATTERNS
    case 'go':
      return GO_PATTERNS
    case 'c':
      return C_PATTERNS
    case 'shell':
      return SHELL_PATTERNS
    case 'sql':
      return SQL_PATTERNS
    default:
      return []
  }
}

/** 抽当前文件里的符号（函数 / 类 / 变量 / 类型 / import 名）。 */
export function collectSymbols(text: string, lang: Lang): SymbolInfo[] {
  const source = String(text ?? '')
  const out: SymbolInfo[] = []
  const seen = new Set<string>()

  for (const [re, kind] of patternsFor(lang)) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) {
      const name = m[1]
      if (name) {
        const line = lineNumberAt(source, m.index)
        if (!seen.has(name)) {
          seen.add(name)
          out.push({ name, kind, line })
        }
      }
      if (re.lastIndex === m.index) re.lastIndex += 1
    }
  }

  // import { a, b as c } from '...' / import x from '...' / from x import a, b
  collectImports(source, lang).forEach((name) => {
    if (seen.has(name)) return
    seen.add(name)
    out.push({ name, kind: 'import', line: 0 })
  })

  return out
}

function collectImports(source: string, lang: Lang): string[] {
  const names: string[] = []
  if (lang === 'ts' || lang === 'js') {
    const braced = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\b/g
    let m: RegExpExecArray | null
    while ((m = braced.exec(source)) !== null) {
      m[1].split(',').forEach((part) => {
        const seg = part.trim()
        if (!seg) return
        const alias = seg.split(/\s+as\s+/)
        const name = (alias[1] ?? alias[0]).trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name)
      })
    }
    const plain = /\bimport\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)\b/g
    while ((m = plain.exec(source)) !== null) names.push(m[1])
  } else if (lang === 'python') {
    const fromImport = /^\s*from\s+[\w.]+\s+import\s+(.+)$/gm
    let m: RegExpExecArray | null
    while ((m = fromImport.exec(source)) !== null) {
      m[1].split(',').forEach((part) => {
        const name = part.trim().split(/\s+as\s+/).pop() ?? ''
        if (/^[A-Za-z_]\w*$/.test(name)) names.push(name)
      })
    }
    const plain = /^\s*import\s+([\w.]+)/gm
    while ((m = plain.exec(source)) !== null) names.push(m[1].split('.')[0])
  } else if (lang === 'rust') {
    const use = /^\s*use\s+[^;]*\{([^}]*)\}/gm
    let m: RegExpExecArray | null
    while ((m = use.exec(source)) !== null) {
      m[1].split(',').forEach((part) => {
        const name = part.trim().split(/\s+as\s+/).pop() ?? ''
        if (/^[A-Za-z_]\w*$/.test(name)) names.push(name)
      })
    }
    const plain = /^\s*use\s+[\w:]*::([A-Za-z_]\w*)\s*;/gm
    while ((m = plain.exec(source)) !== null) names.push(m[1])
  } else if (lang === 'go') {
    const block = /\bimport\s*\(([\s\S]*?)\)/g
    let m: RegExpExecArray | null
    while ((m = block.exec(source)) !== null) {
      const re = /"([^"]+)"/g
      let inner: RegExpExecArray | null
      while ((inner = re.exec(m[1])) !== null) {
        const seg = inner[1].split('/').pop() ?? ''
        if (/^[A-Za-z_]\w*$/.test(seg)) names.push(seg)
      }
    }
    const single = /\bimport\s+"([^"]+)"/g
    while ((m = single.exec(source)) !== null) {
      const seg = m[1].split('/').pop() ?? ''
      if (/^[A-Za-z_]\w*$/.test(seg)) names.push(seg)
    }
  }
  return names
}

/** 1 基行号：给候选的 detail 用。 */
export function lineNumberAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

// ---------------------------------------------------------------- 候选与排序

export type PathEntry = { name: string; isDir: boolean }

/** import 字符串里的路径补全：按最后一段匹配同目录的文件 / 子目录。 */
export function pathCandidates(entries: PathEntry[], prefix: string): Candidate[] {
  const raw = String(prefix ?? '').replace(/\\/g, '/')
  const cut = raw.lastIndexOf('/')
  const dir = cut >= 0 ? raw.slice(0, cut + 1) : ''
  const tail = (cut >= 0 ? raw.slice(cut + 1) : raw).toLowerCase()

  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const entry of entries) {
    const name = String(entry?.name ?? '').trim()
    if (!name) continue
    if (tail && !name.toLowerCase().startsWith(tail)) continue
    const label = entry.isDir ? `${name}/` : name
    if (seen.has(label)) continue
    seen.add(label)
    out.push({
      label,
      insert: dir + label,
      kind: 'path',
      detail: entry.isDir ? '目录' : '文件',
      score: (tail ? 60 : 40) + (entry.isDir ? 5 : 0),
    })
  }
  return out.sort(byScore).slice(0, 50)
}

export type BuildArgs = {
  lang: Lang
  ctx: CompletionContext
  /** 当前文件符号 */
  local: SymbolInfo[]
  /** 同目录其他文件抽出来的符号 */
  workspace?: Candidate[]
  /** 同目录条目（path 模式用） */
  entries?: PathEntry[]
  /** 手动触发：允许空前缀也给候选 */
  manual?: boolean
}

export function buildCandidates({ lang, ctx, local, workspace = [], entries = [], manual = false }: BuildArgs): Candidate[] {
  if (ctx.mode === 'path') {
    return pathCandidates(entries, ctx.prefix)
  }

  const pool: Candidate[] = []

  for (const sym of local) {
    pool.push({
      label: sym.name,
      kind: 'local',
      detail: `${kindLabel(sym.kind)} · 本文件${sym.line ? `:${sym.line}` : ''}`,
      score: 30,
    })
  }
  pool.push(...workspace)
  for (const word of keywordList(lang)) {
    pool.push({ label: word, kind: 'keyword', detail: '关键字', score: 0 })
  }

  if (!manual && ctx.mode === 'word' && ctx.prefix.length < 1) return []
  return rankCandidates(pool, ctx.prefix, 60, ctx.mode === 'member')
}

function kindLabel(kind: SymbolKind): string {
  switch (kind) {
    case 'function':
      return '函数'
    case 'class':
      return '类'
    case 'type':
      return '类型'
    case 'import':
      return '导入'
    default:
      return '变量'
  }
}

const KIND_BONUS: Record<CandidateKind, number> = {
  local: 24,
  member: 20,
  workspace: 12,
  path: 6,
  keyword: 0,
}

/**
 * 过滤 + 打分 + 去重。
 *
 * 打分只看「前缀匹配得多紧」和来源：同文件符号 > 同目录符号 > 关键字。
 * 成员访问（`.` 之后）时本文件符号再抬一档——没有类型信息，这已经是最有用的近似。
 */
export function rankCandidates(pool: Candidate[], prefix: string, limit = 60, member = false): Candidate[] {
  const needle = String(prefix ?? '')
  const lower = needle.toLowerCase()
  const best = new Map<string, Candidate>()

  for (const cand of pool) {
    const label = String(cand?.label ?? '')
    if (!label) continue
    const labelLower = label.toLowerCase()

    let base = -1
    if (!needle) base = 10
    else if (label.startsWith(needle)) base = 100
    else if (labelLower.startsWith(lower)) base = 78
    else if (needle.length >= 2 && labelLower.includes(lower)) base = 34
    if (base < 0) continue

    // 完全等于正在打的前缀：排在最后，避免回车直接 "补全成自己"
    if (label === needle) base -= 90

    const score =
      base +
      (KIND_BONUS[cand.kind] ?? 0) +
      (member && cand.kind === 'local' ? 12 : 0) +
      Math.max(0, 24 - label.length) * 0.4

    const prev = best.get(label)
    if (!prev || (prev.score ?? 0) < score) {
      best.set(label, { ...cand, score })
    }
  }

  return Array.from(best.values()).sort(byScore).slice(0, Math.max(1, limit))
}

function byScore(a: Candidate, b: Candidate): number {
  const diff = (b.score ?? 0) - (a.score ?? 0)
  if (diff !== 0) return diff
  return a.label.localeCompare(b.label)
}

/** 接受一个候选：替换上下文区间，返回新文本与光标位置。 */
export function applyCompletion(text: string, ctx: CompletionContext, cand: Candidate): { text: string; caret: number } {
  const insert = cand.insert ?? cand.label
  const before = text.slice(0, ctx.start)
  const after = text.slice(ctx.end)
  return { text: `${before}${insert}${after}`, caret: ctx.start + insert.length }
}

/** 光标偏移 → 行列（0 基）。补齐浮层定位用。 */
export function caretLineCol(text: string, pos: number): { line: number; col: number } {
  const caret = Math.max(0, Math.min(pos, text.length))
  let line = 0
  let lastBreak = -1
  for (let i = 0; i < caret; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1
      lastBreak = i
    }
  }
  return { line, col: caret - (lastBreak + 1) }
}

// ---------------------------------------------------------------- 浮层定位

export type PlacementInput = {
  line: number
  col: number
  /** 等宽字符宽（px） */
  charWidth: number
  scrollTop: number
  scrollLeft: number
  /** 编辑区（含行号列）尺寸 */
  paneWidth: number
  paneHeight: number
  /** 候选条数 */
  rows: number
}

export type Placement = { left: number; top: number; width: number }

/** 与 CSS 对齐的常量 */
export const POPUP_WIDTH = 330
export const POPUP_ROW_HEIGHT = 22
export const POPUP_HEAD = 24
export const POPUP_MAX_ROWS = 9
const GUTTER = 68
const PADDING_LEFT = 12

/**
 * 补全浮层放在光标下方；下方放不下就翻到上方；左右夹在编辑区内。
 *
 * 抽成纯函数是因为这段算术最容易「看起来对、实际偏一截」，
 * 又只有在真实布局里才看得出来——单测比截图便宜。
 */
export function popupPlacement(input: PlacementInput): Placement {
  const paneWidth = Math.max(0, input.paneWidth || 0)
  const paneHeight = Math.max(0, input.paneHeight || 0)
  const width = Math.min(POPUP_WIDTH, Math.max(Math.min(120, paneWidth), paneWidth - 8))
  const height = Math.min(Math.max(1, input.rows), POPUP_MAX_ROWS) * POPUP_ROW_HEIGHT + POPUP_HEAD

  const x = GUTTER + PADDING_LEFT + input.col * input.charWidth - input.scrollLeft
  const maxLeft = Math.max(0, paneWidth - width - 4)
  const left = Math.max(0, Math.min(x, maxLeft))

  const caretTop = input.line * 19 - input.scrollTop
  let top = caretTop + 19
  if (paneHeight > 0 && top + height > paneHeight) {
    top = caretTop - height
  }
  if (top < 0) top = 0

  return { left, top, width }
}
