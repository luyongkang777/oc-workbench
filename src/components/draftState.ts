/**
 * 输入框草稿的键与转换（纯函数，便于单测）。
 *
 * 键 = `项目路径::会话 id`：换项目、换会话都各存各的，不会串。
 * 会话还没建时用「标签 id」当后缀——同一个项目里可能开着好几个空标签，
 * 只按项目分键的话它们会共用一份草稿，互相把字盖掉。
 */
import type { ChatAttachment } from './attachments'
import type { StoredAttachment, StoredDraft } from '../api/draft'

/** 会话还没建时的占位前缀。 */
export const NEW_SESSION_PREFIX = 'tab:'

/** 草稿键。项目路径里的反斜杠/盘符原样保留，落盘侧会折算成文件名。 */
export function draftKeyOf(root: string, sessionID: string | null, scope?: string): string {
  if (sessionID) return `${root}::${sessionID}`
  return `${root}::${NEW_SESSION_PREFIX}${scope ?? 'blank'}`
}

/** 这个草稿键是不是「还没建会话的空标签」（用来判断要不要把草稿搬进新会话）。 */
export function isBlankDraftKey(key: string): boolean {
  const at = key.lastIndexOf('::')
  return at >= 0 && key.slice(at + 2).startsWith(NEW_SESSION_PREFIX)
}

/** 待发送附件 → 盘上形状（去掉 blob 预览地址）。 */
export function toStored(attachments: ChatAttachment[]): StoredAttachment[] {
  return attachments.map((file) => ({
    name: file.name,
    mime: file.mime,
    dataUrl: file.dataUrl,
    bytes: file.bytes,
  }))
}

/**
 * 盘上形状 → 待发送附件。
 *
 * 预览图直接用 dataUrl：以前只存 blob URL，重开工作台后那个 URL 已经失效，
 * 就算草稿回来了图也是破的。dataUrl 本来就要发给模型，复用它不额外占内存。
 */
export function fromStored(files: StoredAttachment[], makeID: (index: number) => string): ChatAttachment[] {
  return files.map((file, index) => ({
    id: makeID(index),
    name: file.name,
    mime: file.mime,
    dataUrl: file.dataUrl,
    bytes: file.bytes,
    previewUrl: file.dataUrl,
  }))
}

/** 当前输入框内容是否值得落盘（全空就不写盘）。 */
export function isDirtyDraft(text: string, files: StoredAttachment[]): boolean {
  return text.trim().length > 0 || files.length > 0
}

/** 打字时的节流间隔：每敲一下就写一次盘太浪费；切走/发送/关窗都会立刻落地，放宽到 600ms 更省 IO。 */
export const DRAFT_SAVE_DELAY_MS = 600

/** 便于 compare：草稿内容相同就不重复写盘。 */
export function draftSignature(text: string, files: StoredAttachment[]): string {
  const parts = files.map((file) => `${file.name}:${file.bytes}:${file.dataUrl.length}`)
  return `${text.length}|${text.slice(0, 32)}|${parts.join(',')}`
}

/**
 * 只算附件部分的指纹。
 *
 * 用它判断「这次改动动没动图片」：没动就只把文字发给外壳，别再传 base64。
 * 取长度和名字已经足够——同一批图片不会在长度完全相同的情况下换成另一张。
 */
export function filesSignature(files: StoredAttachment[]): string {
  return files.map((file) => `${file.name}:${file.mime}:${file.bytes}:${file.dataUrl.length}`).join(',')
}
