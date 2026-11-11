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
