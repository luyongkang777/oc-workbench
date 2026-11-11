/**
 * Markdown 里的图片 src → 相对工作区根的路径（纯计算，便于单测）。
 *
 * 支持这几种写法：
 *   `F:\proj\a.png`、`F:/proj/a.png`、`/f/proj/a.png`（Git Bash 风格）、
 *   `file:///F:/proj/a.png`、`./docs/a.png`、`docs/a.png`
 *
 * 远程地址、data URL、不在工作区内的绝对路径一律返回 null（调用方显示占位）。
 */
export function localPathOf(root: string, src: string | undefined): string | null {
  if (!src) return null
  let raw = src.trim()
  if (!raw) return null

  if (/^file:\/\//i.test(raw)) {
    raw = raw.replace(/^file:\/\//i, '')
    try {
      raw = decodeURIComponent(raw)
    } catch {
      // 非法百分号编码就当原样
    }
    // file:///C:/x → C:/x
    raw = raw.replace(/^\/([a-zA-Z]:)/, '$1')
  }
  // 有 scheme 的（http/data/blob/mailto/vscode…）都不是本地文件；
  // 盘符不是 scheme，单独放行
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) return null
  if (raw.startsWith('//')) return null

  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const abs = norm(raw)
  const isAbs = /^[a-zA-Z]:\//.test(abs) || abs.startsWith('/')

  if (!isAbs) return abs.replace(/^\.\//, '')

  // /f/opencode/x → f:/opencode/x，方便和工作区根前缀比较
  let full = abs
  if (!/^[a-zA-Z]:\//.test(full) && /^\/[a-zA-Z]\//.test(full)) {
    full = `${full[1]}:/${full.slice(3)}`
  }
  const base = norm(root)
  if (!base) return null
  if (full.toLowerCase() === base.toLowerCase()) return ''
  if (!full.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return null
  return full.slice(base.length + 1)
}

/**
 * 决定「打开这个文件该用哪个 root」。
 *
 * 会话里的路径经常是绝对路径（`C:\Users\..\plan\x.md`、`/c/Users/../x.md`），
 * 而本地文件通道只接受相对 root 的路径：盘符那一段会被当成非法片段，直接 400
 * 「路径不允许包含盘符」。所以这里先拆开——落在当前工作区内就转成相对路径，
 * 落在外面就把 root 换成该文件所在目录（只影响编辑器，不动整个工作区）。
 *
 * 返回的 path 为空表示指向的就是 root 本身（目录），调用方应当忽略。
 */
export function splitOpenPath(root: string, path: string): { root: string; path: string } {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  let full = norm(path)
  if (!full) return { root, path }

  // Git Bash 风格 /c/Users/x → c:/Users/x
  if (/^\/[a-zA-Z]\//.test(full)) full = `${full[1]}:${full.slice(2)}`

  // 盘符根（`C:` / `C:/`）是目录，没有可打开的文件
  if (/^[a-zA-Z]:$/.test(full)) return { root, path: '' }

  if (!/^[a-zA-Z]:\//.test(full)) {
    return { root, path: full.replace(/^\.\//, '') }
  }

  const base = norm(root)
  const lowerFull = full.toLowerCase()
  const lowerBase = base.toLowerCase()
  if (lowerFull === lowerBase) return { root, path: '' }
  if (lowerBase && lowerFull.startsWith(`${lowerBase}/`)) {
    return { root, path: full.slice(base.length + 1) }
  }

  const cut = full.lastIndexOf('/')
  // cut <= 1 说明只到盘符根（`C:/`），没有文件名可开
  if (cut <= 1) return { root, path }
  return { root: full.slice(0, cut), path: full.slice(cut + 1) }
}

/**
 * 规范化「用户手输/粘贴的目录路径」：`"C:\Users\x"`、`C:/Users/x`、`/c/Users/x`、
 * `file:///C:/Users/x`、带尾斜杠的写法，统一成 `C:\Users\x`。
 *
 * 资源管理器「复制路径」会带一对英文引号，Git Bash 里 `pwd` 给的是 `/c/...`，
 * 这两种直接喂给 realpath 都会 404，所以在进 applyRoot 之前先抹平。
 * 空串或只剩空白时返回空串，调用方忽略。
 */
export function normalizeRootPath(input: string): string {
  let raw = String(input ?? '').trim()
  if (!raw) return ''

  // 首尾引号（资源管理器复制路径）
  raw = raw.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim()
  if (!raw) return ''

  if (/^file:\/\//i.test(raw)) {
    raw = raw.replace(/^file:\/\//i, '')
    try {
      raw = decodeURIComponent(raw)
    } catch {
      // 非法百分号编码就按原样
    }
    // file:///C:/x → C:/x
    raw = raw.replace(/^\/([a-zA-Z]:)/, '$1')
  }

  // 统一成反斜杠，Git Bash 的 /c/Users → C:\Users
  raw = raw.replace(/\//g, '\\')
  if (/^\\[a-zA-Z]\\/.test(raw)) raw = `${raw[1].toUpperCase()}:\\${raw.slice(3)}`

  // 去尾斜杠，但盘符根（C:\）保留
  while (raw.length > 3 && raw.endsWith('\\')) raw = raw.slice(0, -1)
  if (/^[a-zA-Z]:$/.test(raw)) raw += '\\'
  return raw
}
