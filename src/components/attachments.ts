/**
 * 聊天附件：待发送图片的选择/压缩/校验，以及消息里附件的本地显示。
 *
 * 两套数据结构：
 *   1. `ChatAttachment` —— 输入框里还没发出去的（带 data URL 和 blob 预览图）；
 *   2. `MessageFile`   —— 服务端消息里回来的（只有 base64 + mime，没有预览图）。
 *
 * 体积口径：opencode 那侧请求体上限 10MB，而 data URL 是 base64（膨胀 4/3），
 * 所以「原始字节」和「data URL 字符数」必须分别限，不能只看文件大小。
 */
import type { MessageFile } from '../api/chat'

/** 一次最多带几张（openclaw/opencode 侧对多图没有硬限制，界面上别太挤）。 */
export const MAX_ATTACHMENTS = 6
/** 单张原始文件上限：再大就该先压缩或裁剪了（压缩后仍按这个口径卡）。 */
export const MAX_SINGLE_BYTES = 6 * 1024 * 1024
/** 读进内存前的绝对上限：超过就不读，避免一张 80MB 的 TIFF 把页面拖死。 */
export const MAX_RAW_BYTES = 32 * 1024 * 1024
/** 全部附件 data URL 的总长上限（留 1MB 给 JSON 外壳和文本）。 */
export const MAX_TOTAL_DATA_URL = 9 * 1024 * 1024
/** 超过这个体积的位图先压一遍再发（截图动辄 2~5MB，压完通常几百 KB）。 */
const IMAGE_COMPRESS_BYTES = 1.2 * 1024 * 1024
const COMPRESS_MAX_SIDE = 2000
const COMPRESS_QUALITY = 0.88

export type ChatAttachment = {
  /** 本地唯一 id（删除、setState 用） */
  id: string
  name: string
  mime: string
  /** 直接发给 opencode 的 data URL */
  dataUrl: string
  /** 压缩后实际字节数 */
  bytes: number
  /** 缩略图用的 blob URL（不用 data URL，避免大字符串常驻 DOM） */
  previewUrl: string
}

const IMAGE_MIME_RE = /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i
/** 扩展名口径与编辑器那边的 isImagePath 一致；这里自己判，避免纯规则模块依赖 UI 模块。 */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i

export function isImageMime(mime: string | undefined): boolean {
  return !!mime && IMAGE_MIME_RE.test(mime)
}

/** 附件是不是图片：优先信 mime，没有就看扩展名。 */
export function isImageFile(file: MessageFile): boolean {
  if (isImageMime(file.mime)) return true
  return !!file.name && IMAGE_EXT_RE.test(file.name)
}

/** 只按文件名猜 mime（WebView 里粘贴的 File 有时 type 是空的）。 */
export function guessMime(name: string): string {
  if (IMAGE_EXT_RE.test(name)) {
    const ext = (name.split('.').pop() ?? '').toLowerCase()
    if (ext === 'svg') return 'image/svg+xml'
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
    return `image/${ext || 'png'}`
  }
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'txt' || ext === 'log') return 'text/plain'
  if (ext === 'md') return 'text/markdown'
  if (ext === 'json') return 'application/json'
  return 'application/octet-stream'
}

/** data URL 里 base64 部分的实际字节数（给「总长别超」的判断用）。 */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const b64 = dataUrl.slice(comma + 1)
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad)
}

export type SkippedFile = { name: string; reason: string }
export type AttachPlan = { accept: number[]; skipped: SkippedFile[]; notice: string | null }

/**
 * 决定这次要加哪几个文件（纯计算，便于单测）。
 *
 * 规则：数量不超 `MAX_ATTACHMENTS`、单个不超 `MAX_SINGLE_BYTES`、
 * 加起来（按 data URL 估算）不超 `MAX_TOTAL_DATA_URL`。超出的跳过并给出原因，
 * 不因为一个坏文件把整批都拒掉。
 */
export function planAttachments(
  existing: { name: string; bytes: number }[],
  incoming: { name: string; bytes: number }[],
): AttachPlan {
  const accept: number[] = []
  const skipped: SkippedFile[] = []
  let count = existing.length
  // data URL 字符数 ≈ 字节数 * 4/3（mime 前缀忽略不计）
  let total = existing.reduce((sum, file) => sum + Math.ceil((file.bytes * 4) / 3), 0)

  incoming.forEach((file, index) => {
    if (count >= MAX_ATTACHMENTS) {
      skipped.push({ name: file.name, reason: `最多 ${MAX_ATTACHMENTS} 个附件` })
      return
    }
    if (file.bytes > MAX_SINGLE_BYTES) {
      skipped.push({ name: file.name, reason: '单张超过 6 MB' })
      return
    }
    const next = total + Math.ceil((file.bytes * 4) / 3)
    if (next > MAX_TOTAL_DATA_URL) {
      skipped.push({ name: file.name, reason: '附件总大小超过 9 MB' })
      return
    }
    accept.push(index)
    count += 1
    total = next
  })

  return { accept, skipped, notice: skipped.length > 0 ? describeSkipped(skipped) : null }
}

/** 把跳过原因拼成一句人话（输入框上方那行提示用它）。 */
export function describeSkipped(skipped: SkippedFile[]): string {
  if (skipped.length === 0) return ''
  if (skipped.length === 1) return `${skipped[0].name} 未加入：${skipped[0].reason}`
  const first = skipped[0]
  return `${first.name} 等 ${skipped.length} 个文件未加入：${first.reason}`
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(blob)
  })
}

/**
 * 大图压成 JPEG：最大边 2000、质量 0.88。
 *
 * 先铺白底再画：PNG 截图里常有透明区域，直接转 JPEG 会变成黑块。
 * 压缩失败（SVG、损坏文件、createImageBitmap 不支持）就原样返回，不阻断发送。
 */
async function compressImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, COMPRESS_MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close?.()
    return file
  }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', COMPRESS_QUALITY)
  })
  return blob && blob.size > 0 ? blob : file
}

let attachmentSeq = 0

/** File → 待发送附件（图片超阈值先压缩）。 */
export async function fileToAttachment(file: File): Promise<ChatAttachment> {
  const guessed = file.type || guessMime(file.name)
  let blob: Blob = file
  if (isImageMime(guessed) && !/gif|svg/i.test(guessed) && file.size > IMAGE_COMPRESS_BYTES) {
    const small = await compressImage(file).catch(() => null)
    // 压完反而更大就别用（小图重编码可能膨胀）
    if (small && small.size > 0 && small.size < file.size) blob = small
  }

  const dataUrl = await readDataUrl(blob)
  if (!dataUrl) throw new Error(`读取 ${file.name} 失败`)

  attachmentSeq += 1
  return {
    id: `att-${Date.now()}-${attachmentSeq}`,
    name: file.name || `图片-${attachmentSeq}.png`,
    mime: blob.type || guessed,
    dataUrl,
    bytes: blob.size,
    previewUrl: URL.createObjectURL(blob),
  }
}

/** 批量转换：坏文件不拖累其它文件，记一条提示就行。 */
export async function filesToAttachments(files: File[]): Promise<{
  attachments: ChatAttachment[]
  errors: string[]
}> {
  const attachments: ChatAttachment[] = []
  const errors: string[] = []
  for (const file of files) {
    try {
      attachments.push(await fileToAttachment(file))
    } catch (err) {
      errors.push(`${file.name}：${(err as Error).message}`)
    }
  }
  return { attachments, errors }
}

/**
 * 服务端消息里的图片 → 可显示的 blob URL（模块级缓存）。
 *
 * 同一条历史消息每次事件刷新都会重新渲染，base64 解码不能每次重做；
 * 缓存不主动 revoke：一个会话里图片数量有限，卸载时统一丢给浏览器回收。
 */
const previewCache = new Map<string, string>()

function fileCacheKey(file: MessageFile): string {
  const data = file.data ?? ''
  return `${file.mime ?? ''}|${data.length}|${data.slice(0, 48)}|${data.slice(-24)}`
}

export function messageFilePreview(file: MessageFile): string | null {
  if (!isImageFile(file)) return null

  if (file.data) {
    const key = fileCacheKey(file)
    const hit = previewCache.get(key)
    if (hit) return hit
    try {
      const binary = atob(file.data)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      const url = URL.createObjectURL(new Blob([bytes], { type: file.mime || 'image/png' }))
      previewCache.set(key, url)
      return url
    } catch {
      return null
    }
  }

  // 没有 data 只有 uri（例如 data URL 原样回来了）：能直接当图片源就用
  const uri = file.uri ?? file.source?.uri ?? ''
  if (/^(?:data:image\/|blob:|https?:\/\/)/i.test(uri)) {
    const key = `uri|${uri.length}|${uri.slice(0, 48)}`
    const hit = previewCache.get(key)
    if (hit) return hit
    previewCache.set(key, uri)
    return uri
  }
  return null
}

/** 收尾时释放输入框附件的 blob URL（消息里的缓存不在这里管）。 */
export function releaseAttachment(attachment: ChatAttachment): void {
  if (attachment.previewUrl.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
}
