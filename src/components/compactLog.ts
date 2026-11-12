/**
 * 压缩记录：压缩是唯一会「悄悄改掉历史」的操作，事后必须还能查到
 * 什么时候压过、压缩前后各多少 token、花多久、有没有失败。
 *
 * 服务端压缩后会把历史重写成摘要，原始消息都不在了，所以这份记录只能
 * 存在本地：按 sessionID 分键写 localStorage，每个会话保留最近 N 条。
 * 存储被禁用（隐私模式）时整体降级为空列表，绝不影响压缩本身。
 */
import { formatTokens } from './contextUsage.ts'

export type CompactRecord = {
  /** 压缩完成（或失败）的时间戳 */
  at: number
  ok: boolean
  /** 压缩前的上下文规模（token）；拿不到时为 0 */
  before: number
  /** 压缩后最新一次请求的上下文规模；拿不到时为 0 */
  after: number
  /** 耗时（毫秒） */
  ms: number
  /** 失败原因（ok=false 时） */
  error?: string
}

export const MAX_COMPACT_RECORDS = 20

const STORE_PREFIX = 'oc-workbench:compacts:'

/** 只依赖 getItem/setItem，方便测试注入内存实现。 */
export type CompactStore = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStore(): CompactStore | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    // 隐私模式 / 禁用存储：记录功能降级，不能影响压缩本身
    return null
  }
}

const keyOf = (sessionID: string) => `${STORE_PREFIX}${sessionID}`

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** 逐字段校验：旧版本写下的、手改坏的、别的代码塞进来的都别让它冒到界面上。 */
function sanitize(value: unknown): CompactRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const at = nonNegative(raw.at)
  if (!at) return null
  const record: CompactRecord = {
    at,
    ok: raw.ok === true,
    before: nonNegative(raw.before),
    after: nonNegative(raw.after),
    ms: nonNegative(raw.ms),
  }
  if (typeof raw.error === 'string' && raw.error.trim()) {
    record.error = raw.error.trim().slice(0, 200)
  }
  return record
}

/** 读某个会话的压缩记录（旧 → 新）。数据坏了当空，不让它拖垮聊天区。 */
export function loadCompactLog(sessionID: string, store: CompactStore | null = defaultStore()): CompactRecord[] {
  if (!sessionID || !store) return []
  let raw: string | null = null
  try {
    raw = store.getItem(keyOf(sessionID))
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(sanitize)
      .filter((item): item is CompactRecord => item !== null)
      .slice(-MAX_COMPACT_RECORDS)
  } catch {
    return []
  }
}

/** 追加一条记录，返回写入后的完整列表（旧 → 新）。 */
export function appendCompactRecord(
  sessionID: string,
  record: CompactRecord,
  store: CompactStore | null = defaultStore(),
): CompactRecord[] {
  const next = [...loadCompactLog(sessionID, store), record].slice(-MAX_COMPACT_RECORDS)
  if (!sessionID || !store) return next
  try {
    store.setItem(keyOf(sessionID), JSON.stringify(next))
  } catch {
    // 写不进去（配额满）也不影响本次压缩，界面里照样有这一条
  }
  return next
}

/** 清空某个会话的记录。 */
export function clearCompactLog(sessionID: string, store: CompactStore | null = defaultStore()): void {
  if (!sessionID || !store) return
  try {
    store.setItem(keyOf(sessionID), '[]')
  } catch {
    // ignore
  }
}

/** 当天只显示时分，跨天补上月-日：压缩可能是几天前做的。 */
export function shortTime(at: number, now = Date.now()): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const sameDay = new Date(now).toDateString() === date.toDateString()
  return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`
}

/** 耗时：不到 1 秒按毫秒报，避免「0.4s」这种没意义的精度。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** 一行记录的主体：436k → 2.5k；失败就写失败。 */
export function recordSize(record: CompactRecord): string {
  if (!record.ok) return '压缩失败'
  if (record.before > 0 && record.after > 0) {
    return `${formatTokens(record.before)} → ${formatTokens(record.after)}`
  }
  return '已压缩'
}

/** 折叠标题：压缩记录 · 3 次 · 最近 18:49（436k → 2.5k） */
export function compactSummary(records: CompactRecord[], now = Date.now()): string {
  if (records.length === 0) return '压缩记录'
  const last = records[records.length - 1]
  const size = last.ok && last.before > 0 && last.after > 0
    ? `（${formatTokens(last.before)} → ${formatTokens(last.after)}）`
    : ''
  return `压缩记录 · ${records.length} 次 · 最近 ${shortTime(last.at, now)}${size}`
}
