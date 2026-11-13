/**
 * 输入框草稿的持久化通道（文字 + 待发送图片）。
 *
 * 为什么不用 localStorage 当主存储：本地服务端口每次启动都变，页面 origin 跟着变，
 * localStorage 按 origin 分区，跨不了启动（和项目清单是同一个原因）。
 * 有外壳就走 `/local/draft/*` 落盘；Vite dev 没有外壳，退化成 localStorage
 * （dev 的 origin 固定是 5273，够用）。
 */

import { localRequest } from './client'
import { hasShellIpc } from './projects'

/** 一条待发送附件在盘上的形状：previewUrl 不存，读回来直接复用 dataUrl。 */
export type StoredAttachment = {
  name: string
  mime: string
  dataUrl: string
  bytes: number
}

export type StoredDraft = {
  text: string
  files: StoredAttachment[]
}

const LS_PREFIX = 'oc-workbench:draft:'

function lsKey(key: string): string {
  return `${LS_PREFIX}${key}`
}

function readLocal(key: string): StoredDraft | null {
  try {
    const raw = window.localStorage.getItem(lsKey(key))
    if (!raw) return null
    return normalize(JSON.parse(raw))
  } catch {
    return null
  }
}

function writeLocal(key: string, draft: StoredDraft | null): void {
  try {
    if (draft) window.localStorage.setItem(lsKey(key), JSON.stringify(draft))
    else window.localStorage.removeItem(lsKey(key))
  } catch {
    // 配额满了只影响 dev 下的恢复，不影响本次输入
  }
}

/**
 * 内存中转：切标签时 Chat 会卸载再重建，卸载那次的写盘还在路上，新建的那份
 * 立刻去读盘会读到旧内容（打字快时肉眼可见地丢字）。所以读一律先看这里——
 * 写入时同步更新，读回来就是最新一份，盘只负责跨启动。
 */
const memory = new Map<string, StoredDraft | null>()

/** 把任意 JSON 收成一个形状对的草稿；坏数据当空。 */
export function normalize(raw: unknown): StoredDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as { draft?: unknown; text?: unknown; files?: unknown }
  // 外壳回的是 `{ key, draft }`，落盘文件本身是 `{ key, text, files }`
  const body = source.draft !== undefined ? source.draft : source
  if (!body || typeof body !== 'object') return null
  const value = body as { text?: unknown; files?: unknown }
  const text = typeof value.text === 'string' ? value.text : ''
  const files: StoredAttachment[] = []
  if (Array.isArray(value.files)) {
    for (const item of value.files) {
      if (!item || typeof item !== 'object') continue
      const file = item as Partial<StoredAttachment>
      if (typeof file.dataUrl !== 'string' || !file.dataUrl) continue
      files.push({
        name: typeof file.name === 'string' && file.name ? file.name : '图片',
        mime: typeof file.mime === 'string' ? file.mime : 'image/png',
        dataUrl: file.dataUrl,
        bytes: typeof file.bytes === 'number' && file.bytes >= 0 ? file.bytes : 0,
      })
    }
  }
  if (!text && files.length === 0) return null
  return { text, files }
}

/** 读一份草稿；没有、读失败、内容空都回 null。先看内存，再看盘。 */
export async function loadDraft(key: string): Promise<StoredDraft | null> {
  if (memory.has(key)) return memory.get(key) ?? null
  const loaded = await readStorage(key)
  memory.set(key, loaded)
  return loaded
}

async function readStorage(key: string): Promise<StoredDraft | null> {
  if (!hasShellIpc()) return readLocal(key)
  try {
    const res = await localRequest<{ draft?: unknown }>(
      `/local/draft/load?key=${encodeURIComponent(key)}`,
    )
    return normalize(res)
  } catch {
    return readLocal(key)
  }
}

/** 写入行为：`keepFiles` 表示图片没变，只更新文字，别重传 base64。 */
export type SaveDraftOptions = { keepFiles?: boolean }

/** 写一份草稿（空草稿直接删，别在盘上留空文件）。内存立刻生效，盘慢慢写。 */
export async function saveDraft(
  key: string,
  draft: StoredDraft,
  options: SaveDraftOptions = {},
): Promise<void> {
  if (!draft.text && draft.files.length === 0) {
    await clearDraft(key)
    return
  }
  memory.set(key, draft)
  if (!hasShellIpc()) {
    writeLocal(key, draft)
    return
  }
  // 打字时只发文字：几张截图的 base64 加起来几 MB，每 200ms 重传一遍太浪费。
  // 外壳收到不带 files 的请求会沿用盘上已有的图片。
  const body = options.keepFiles ? { text: draft.text } : draft
  try {
    await localRequest<{ ok?: boolean }>(
      `/local/draft/save?key=${encodeURIComponent(key)}`,
      undefined,
      undefined,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
      },
    )
  } catch {
    // 存不进去不影响继续输入；下一次改动还会重试
  }
}

/** 发送成功后清掉草稿。 */
export async function clearDraft(key: string): Promise<void> {
  memory.set(key, null)
  if (!hasShellIpc()) {
    writeLocal(key, null)
    return
  }
  try {
    await localRequest<{ ok?: boolean }>(
      `/local/draft/clear?key=${encodeURIComponent(key)}`,
      undefined,
      undefined,
      { method: 'POST' },
    )
  } catch {
    // 清不掉最多下次多恢复一次，不影响发送结果
  }
}
