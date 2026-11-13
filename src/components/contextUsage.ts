/**
 * 上下文用量（纯计算，不碰 React，方便单测）。
 *
 * 数据来自两处：
 * - 最近一条 assistant 消息的 `tokens`：这次请求真实带上了多少上下文
 * - 模型自己的 `limit.context`：窗口上限
 *
 * 注意 `input` 只是没命中缓存的部分，缓存前缀在 `cache.read` 里；
 * 两者相加才是上下文规模。只看 input 会显示成「几十 token」这种假数字。
 */
import type { ChatMessage } from '../api/chat'

export type ContextUsage = {
  /** 下一次请求会带上的上下文估算（input + cache.read + cache.write + output） */
  used: number
  /** 模型上下文上限；0 = 未知 */
  limit: number
  /** 0-100；limit 未知时为 0 */
  percent: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** 是否拿到过用量数据 */
  known: boolean
}

function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export function emptyUsage(limit = 0): ContextUsage {
  return {
    used: 0,
    limit: Math.max(0, limit),
    percent: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    known: false,
  }
}

/**
 * 这条消息的 tokens 里有没有真实读数。
 *
 * `tokens` 缺失很常见：正在流式输出的这一步、被打断的这一步、以及刚插进来的骨架
 * 都没有。只有「字段在且至少有一个正数」才算用过模型，全 0 的同样当没有。
 */
function hasUsage(tokens: ChatMessage['tokens']): boolean {
  if (!tokens) return false
  return (
    num(tokens.input) + num(tokens.output) + num(tokens.cache?.read) + num(tokens.cache?.write) > 0
  )
}

/**
 * 从消息列表算当前上下文占用。
 *
 * 消息是「最新在前」的，所以第一条**带 tokens** 的 assistant 就是最近一次调用；
 * 还没跑过模型时返回 known=false，界面显示占位而不是 0%。
 *
 * 不能直接取第一条 assistant：生成中的这一步（骨架消息）和被打断的这一步都没有
 * tokens，拿它们当「最近一次调用」会让整个读数退回占位——表现就是聊了半天，
 * 顶栏的上下文胶囊一直停在「—」。正确做法是跳过这些没有读数的步骤，用上一条
 * 已落地的调用。
 *
 * 压缩消息是例外：它是界线而不是普通步骤。最新的压缩消息即使没有 tokens 也不
 * 往更早翻——压缩前的 400k 和压缩后剩下的摘要不是一回事，回退只会给出假数字。
 */
export function computeContextUsage(messages: ChatMessage[], limit = 0): ContextUsage {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 0
  let latest: ChatMessage | undefined
  for (const message of messages) {
    if (message.type === 'compaction') {
      latest = message
      break
    }
    if (message.type !== 'assistant') continue
    if (!hasUsage(message.tokens)) continue
    latest = message
    break
  }
  if (!latest?.tokens) return emptyUsage(safeLimit)

  // compaction 的 tokens 记的是「生成摘要这次调用」的用量：input/cache 是压缩前
  // 那一大坨历史（461k），不是压缩后剩下的。拿它当当前占用会得出「461k → 461k」，
  // 完全是误导。压缩后的上下文只有摘要本身，按 output 计。
  if (latest.type === 'compaction') {
    const summary = num(latest.tokens.output)
    const percent = safeLimit > 0 && summary > 0 ? Math.min(100, (summary / safeLimit) * 100) : 0
    return {
      used: summary,
      limit: safeLimit,
      percent,
      input: 0,
      output: summary,
      cacheRead: 0,
      cacheWrite: 0,
      known: summary > 0,
    }
  }

  const input = num(latest.tokens.input)
  const output = num(latest.tokens.output)
  const cacheRead = num(latest.tokens.cache?.read)
  const cacheWrite = num(latest.tokens.cache?.write)
  const used = input + output + cacheRead + cacheWrite
  const percent = safeLimit > 0 ? Math.min(100, (used / safeLimit) * 100) : 0

  return { used, limit: safeLimit, percent, input, output, cacheRead, cacheWrite, known: true }
}

/** 丢弃小数末尾的 .0，避免出现「1.0M」。 */
function trim(value: string): string {
  return value.replace(/\.0$/, '')
}

/** token 数的短写法：169k / 1.2M；和截图里的口径一致。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  const n = Math.round(value)
  if (n >= 1_000_000) return `${trim((n / 1_000_000).toFixed(1))}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${trim((n / 1000).toFixed(1))}k`
  return String(n)
}

/** tooltip / 面板标题那一行：已用上下文长度：18%（已用 169k，共 1M）。 */
export function contextHint(usage: ContextUsage): string {
  if (!usage.known) return '还没有用量数据（这个会话还没跑过模型）'
  const percent = `${Math.round(usage.percent)}%`
  if (usage.limit > 0) {
    return `已用上下文长度：${percent}（已用 ${formatTokens(usage.used)}，共 ${formatTokens(usage.limit)}）`
  }
  return `已用上下文长度：${percent}（已用 ${formatTokens(usage.used)}，模型上限未知）`
}

/** 进度条 / 文字的告警档位：越接近上限越红。 */
export function usageTone(usage: ContextUsage): 'idle' | 'ok' | 'warn' | 'danger' {
  if (!usage.known) return 'idle'
  if (usage.limit <= 0) return 'ok'
  if (usage.percent >= 90) return 'danger'
  if (usage.percent >= 70) return 'warn'
  return 'ok'
}
