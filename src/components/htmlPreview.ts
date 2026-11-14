/**
 * HTML 预览的资源内联（纯逻辑，便于单测）。
 *
 * 预览是在沙盒 iframe 里用 `srcdoc` 渲染的：不给 `allow-same-origin`，
 * 页面拿不到父窗口的 token 和 localStorage（安全上必须这样），
 * 代价是页面里的**相对路径资源**（`style.css`、`app.js`、`logo.png`）
 * 会按 `about:srcdoc` 解析，一律加载失败 —— 用户看到的就是白屏或没样式。
 *
 * 这里在渲染前把本地相对资源读出来换成 `data:` URL 内联进 HTML，
 * 静态页面就能正常显示。仍然是沙盒：内联进来的脚本能跑，但同样拿不到父页面。
 */

/** 单个资源上限：再大内联进去会把 iframe 撑爆。 */
export const RESOURCE_MAX_BYTES = 3 * 1024 * 1024
/** 内联资源总量上限。 */
export const RESOURCE_TOTAL_MAX_BYTES = 12 * 1024 * 1024
/** 最多内联多少个资源。 */
export const RESOURCE_MAX_COUNT = 40

export type ResourceKind = 'css' | 'script' | 'image'

export type ResourceRef = {
  kind: ResourceKind
  /** 原文里的引用值（可能带引号、查询串） */
  ref: string
  /** 相对 root 的路径（已归一），拿不到时为 null */
  rel: string | null
}

/**
 * 按扩展名给内联资源定 MIME。
 *
 * 不能依赖后端返回的 content-type：本地文件接口只对图片/PDF 给了正确类型，
 * .css / .js 会回 application/octet-stream，浏览器拿到
 * `data:application/octet-stream` 的样式表会直接忽略 —— 表现就是「内联了但样式没生效」。
 */
export function mimeOf(relPath: string): string {
  const ext = (relPath.split('.').pop() ?? '').toLowerCase()
  switch (ext) {
    case 'css':
      return 'text/css'
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'text/javascript'
    case 'json':
      return 'application/json'
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    case 'ico':
      return 'image/x-icon'
    case 'svg':
      return 'image/svg+xml'
    case 'woff':
      return 'font/woff'
    case 'woff2':
      return 'font/woff2'
    case 'ttf':
      return 'font/ttf'
    case 'otf':
      return 'font/otf'
    case 'mp4':
      return 'video/mp4'
    case 'webm':
      return 'video/webm'
    case 'mp3':
      return 'audio/mpeg'
    case 'wav':
      return 'audio/wav'
    default:
      return 'application/octet-stream'
  }
}

/** 字节 → base64（分块处理，避免大文件把参数列表撑爆）。 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** 资源字节 → data URL（MIME 由路径决定，不看后端给的类型）。 */
export function toDataUrl(relPath: string, bytes: Uint8Array): string {
  return `data:${mimeOf(relPath)};base64,${toBase64(bytes)}`
}

/** 路径里最后一段（文件名）。 */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** 路径所在目录（不带结尾分隔符）；顶层文件返回空串。 */
export function dirOf(path: string): string {
  const parts = path.split(/[\\/]/)
  parts.pop()
  return parts.join('/')
}

/**
 * 把引用值解析成「相对 root 的路径」。
 *
 * 返回 null 表示不用内联：绝对 URL、协议相对、`data:`、`#锚点`、`mailto:` 等，
 * 以及跳出工作区（`../..`）的路径。
 */
export function resolveRelative(htmlPath: string, ref: string): string | null {
  const raw = ref.trim()
  if (!raw) return null
  // 外部资源 / 内联资源：交给浏览器自己处理（沙盒里外链本来也会被网络策略拦）
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) return null
  if (raw.startsWith('#')) return null
  // 去掉查询串和锚点：本地文件按路径读，不认 URL 语义
  const clean = raw.split(/[?#]/)[0]
  if (!clean) return null

  const segments = clean.startsWith('/')
    ? [] // 以 / 开头在文件系统里没有意义，按工作区根算
    : dirOf(htmlPath).split('/').filter(Boolean)
  for (const part of clean.split(/[\\/]+/)) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (segments.length === 0) return null // 跳出工作区
      segments.pop()
      continue
    }
    segments.push(part)
  }
  if (segments.length === 0) return null
  return segments.join('/')
}

/** 把一段 HTML 里的本地相对资源挑出来（保持出现顺序，去重）。 */
export function collectResources(html: string, htmlPath: string): ResourceRef[] {
  const found: ResourceRef[] = []
  const push = (kind: ResourceKind, ref: string) => {
    if (found.some((item) => item.ref === ref && item.kind === kind)) return
    found.push({ kind, ref, rel: resolveRelative(htmlPath, ref) })
  }

  // <link rel="stylesheet" href="...">
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0]
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
    if (href) push('css', href[1] ?? href[2] ?? href[3] ?? '')
  }
  // <script src="...">
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[0])
    if (src) push('script', src[1] ?? src[2] ?? src[3] ?? '')
  }
  // <img src="..."> / <source src="...">
  for (const match of html.matchAll(/<(?:img|source)\b[^>]*>/gi)) {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[0])
    if (src) push('image', src[1] ?? src[2] ?? src[3] ?? '')
  }
  return found
}

/** 把 HTML 里某个引用值替换成 data URL（只替换带引号/裸值这几种写法）。 */
function replaceRef(html: string, ref: string, dataUrl: string): string {
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return html
    .replace(new RegExp(`"(?:${escaped})"`, 'g'), `"${dataUrl}"`)
    .replace(new RegExp(`'(?:${escaped})'`, 'g'), `'${dataUrl}'`)
    .replace(new RegExp(`(\\s(?:href|src)=)(?:${escaped})(?=[\\s>])`, 'g'), `$1"${dataUrl}"`)
}

export type InlineResult = {
  html: string
  /** 成功内联的资源数 */
  inlined: number
  /** 因为太大 / 读失败而跳过的资源 */
  skipped: string[]
}

/**
 * 把本地相对资源内联进 HTML。
 *
 * `load(relPath)` 返回文件字节（读不到返回 null）。
 * 单个太大、总量超限、读失败的一律跳过并记录，不让一个坏资源毁掉整个预览。
 */
export async function inlineLocalResources(
  html: string,
  htmlPath: string,
  load: (relPath: string) => Promise<Uint8Array | null>,
): Promise<InlineResult> {
  const refs = collectResources(html, htmlPath).filter((item) => item.rel !== null)
  if (refs.length === 0) return { html, inlined: 0, skipped: [] }

  let out = html
  let inlined = 0
  let total = 0
  const skipped: string[] = []
  // 同一个 rel 只读一次（多个标签引用同一个文件很常见）
  const cache = new Map<string, string | null>()
  let count = 0

  for (const item of refs) {
    if (!item.rel) continue
    if (count >= RESOURCE_MAX_COUNT || total >= RESOURCE_TOTAL_MAX_BYTES) {
      skipped.push(item.rel)
      continue
    }
    let dataUrl = cache.get(item.rel)
    if (dataUrl === undefined) {
      const bytes = await load(item.rel).catch(() => null)
      if (!bytes || bytes.length > RESOURCE_MAX_BYTES) {
        cache.set(item.rel, null)
        skipped.push(item.rel)
        continue
      }
      dataUrl = toDataUrl(item.rel, bytes)
      cache.set(item.rel, dataUrl)
      total += bytes.length
    }
    if (!dataUrl) {
      skipped.push(item.rel)
      continue
    }
    count += 1
    inlined += 1
    out = replaceRef(out, item.ref, dataUrl)
  }
  return { html: out, inlined, skipped }
}

/** 单测/调试用：把 blob 描述成一句人话。 */
export function describeSkipped(skipped: string[]): string | null {
  if (skipped.length === 0) return null
  const names = [...new Set(skipped.map((item) => baseName(item) || item))]
  const shown = names.slice(0, 3).join('、')
  const more = names.length > 3 ? ` 等 ${names.length} 个` : ''
  return `${shown}${more}`
}

/**
 * 去掉脚本/样式/注释后还剩多少「看得见的静态内容」。
 *
 * 用来判断一个 HTML 是不是纯粹靠脚本渲染：只剩 `<div id="root"></div>` 这种空壳时，
 * 沙盒预览必然是白屏，得给用户一句解释，而不是让人以为预览坏了。
 */
function staticTextOf(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * HTML 预览的说明：只在「预览可能看不出内容」时给一句人话。
 *
 * 只看原 HTML 不够：相对资源已经被内联过，
 * 所以判定「还有没有缺失的资源」要拿内联结果的 `skipped` 判断。
 */
export function htmlPreviewNote(
  original: string,
  options?: { skipped?: string[]; inlined?: number },
): string | null {
  const skipped = options?.skipped ?? []
  const inlined = options?.inlined ?? 0
  const staticText = staticTextOf(original)
  const notes: string[] = []

  // 正文全靠脚本生成时，空白是「正常结果」，得说明白，不然像坏了
  if (staticText.length < 3) {
    notes.push('这个页面的正文由脚本生成，预览里可能是一片空白')
  }

  // 只有真的没内联成功才提缺资源
  const missingText = describeSkipped(skipped)
  if (missingText) {
    notes.push(`${missingText} 没能加载（太大或读取失败），预览里会缺这部分`)
  }
  // 内联过就顺带说清「外链资源不进预览」，避免用户以为是 bug
  if (inlined > 0) {
    notes.push('同目录的样式 / 脚本 / 图片已内联进预览；外站链接不会加载')
  }
  if (notes.length === 0) return null
  return `${notes.join('；')}。点「源码」可以看原始代码。`
}
