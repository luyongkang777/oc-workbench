/**
 * 子智能体面板的行模型（纯函数，不 import React / fetch，node 直接可测）。
 *
 * 输入是 api/chat 的 SubagentNode，输出是界面直接画的东西：
 * 状态、正在跑的工具、耗时、烧了多少。
 *
 * 所有函数都不抛：字段缺失按默认值走，宁可少显示也不能让面板崩。
 */

import type { MessagePart } from '../api/chat'

/** 面板里真正用到的字段（和 SessionInfo 结构兼容，但不强依赖它，方便单测） */
export type SubagentSession = {
  id: string
  title?: string
  agent?: string
  depth?: number
  time?: { created?: number; updated?: number; busy?: number; idle?: number; archived?: number }
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  cost?: number
  outcome?: 'succeeded' | 'failed' | 'interrupted'
}

/** 状态四态：跑动 / 成功 / 失败 / 未知（还没结束但也不忙） */
export type SubagentState = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'idle'

export type SubagentRow = {
  id: string
  /** 显示用短 id：会话 id 前缀都一样，看尾部才有区分度 */
  short: string
  title: string
  agent: string
  depth: number
  state: SubagentState
  /** 状态符号 */
  mark: string
  /** 已耗时（毫秒）：跑动 = busy→现在，结束 = busy→idle */
  elapsedMs: number
  /** 输出 token（output + reasoning，这是真正生成的量） */
  outTokens: number
  /** 输入 token 合计（input + cache.read），体现上下文吃了多少 */
  inTokens: number
  cost: number
  /** 正在跑的工具名，没在跑就是空串 */
  tool: string
  /** 工具参数摘要 */
  detail: string
}

// ---------------------------------------------------------------- 面板显示模式

/**
 * 面板显示模式。
 *   auto   —— 有子智能体才展开，没有就收成一条细条（默认：不白占编辑器宽度）
 *   open   —— 用户手动展开，一直开着
 *   closed —— 用户手动收起
 */
export type SubagentMode = 'auto' | 'open' | 'closed'

/** 从 localStorage 里读到的原始值解析成模式；认不出来一律 auto。 */
export function parseSubagentMode(raw: string | null | undefined): SubagentMode {
  if (raw === 'open' || raw === '1') return 'open'
  if (raw === 'closed' || raw === '0') return 'closed'
  return 'auto'
}

/** 该不该显示成整块面板（false = 收成细条）。 */
export function isExpanded(mode: SubagentMode, rowCount: number): boolean {
  if (mode === 'open') return true
  if (mode === 'closed') return false
  return rowCount > 0
}

// ---------------------------------------------------------------- 状态判定

/**
 * 会话状态。
 *
 * 判据跟 workbench 已有的 isSessionBusy 一致（busy > idle = 在生成），
 * 另外优先认服务端给的 outcome：那是上一轮的最终结论，比时间戳更权威。
 */
export function stateOf(session: SubagentSession, now: number): SubagentState {
  const busy = session.time?.busy ?? 0
  const idle = session.time?.idle ?? 0
  if (busy > idle) return 'running'
  if (session.outcome === 'failed') return 'failed'
  if (session.outcome === 'interrupted') return 'interrupted'
  if (session.outcome === 'succeeded') return 'succeeded'
  // 没有 outcome：跑过但没写结局，按空闲处理，别假装成功
  return 'idle'
}

export function stateMark(state: SubagentState): string {
  switch (state) {
    case 'running':
      return '▶'
    case 'succeeded':
      return '✓'
    case 'failed':
      return '✕'
    case 'interrupted':
      return '■'
    default:
      return '·'
  }
}

// ---------------------------------------------------------------- 耗时 / 用量

export function elapsedOf(session: SubagentSession, now: number): number {
  const time = session.time ?? {}
  const start = time.busy ?? time.created ?? now
  const running = (time.busy ?? 0) > (time.idle ?? 0)
  const end = running ? now : (time.idle ?? time.updated ?? now)
  return Math.max(0, end - start)
}

/** 输出 token：模型真正写出来的量。 */
export function outTokensOf(session: SubagentSession): number {
  const tokens = session.tokens
  if (!tokens) return 0
  return (tokens.output ?? 0) + (tokens.reasoning ?? 0)
}

/**
 * 输入 token：没命中缓存的 + 命中缓存的。
 *
 * 只算 input 会把几百 k 的缓存前缀漏掉，看着像「这个子智能体没吃上下文」。
 */
export function inTokensOf(session: SubagentSession): number {
  const tokens = session.tokens
  if (!tokens) return 0
  return (tokens.input ?? 0) + (tokens.cache?.read ?? 0)
}

// ---------------------------------------------------------------- 正在跑什么

const INPUT_KEYS = ['command', 'filePath', 'path', 'pattern', 'query', 'url', 'description', 'prompt']

/** 从工具入参里挑一个最有信息量的字符串（和 turns.ts 的 toolDetail 同口径）。 */
export function summarizeInput(input?: Record<string, unknown>): string {
  if (!input || typeof input !== 'object') return ''
  for (const key of INPUT_KEYS) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export type Activity = { tool: string; detail: string }

/**
 * 从消息里取「最后一次动作」。
 *
 * 服务端消息是倒序（最新在前），但为了不依赖顺序，这里从尾部往前扫，
 * 谁位置靠后就取谁。只认 assistant 消息里的 tool / text 段。
 */
export function pickActivity(messages?: Array<{ type?: string; content?: MessagePart[] }>): Activity {
  if (!Array.isArray(messages) || messages.length === 0) return { tool: '', detail: '' }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || message.type !== 'assistant') continue
    const content = message.content
    if (!Array.isArray(content)) continue

    for (let j = content.length - 1; j >= 0; j -= 1) {
      const part = content[j]
      if (!part) continue
      if (part.type === 'tool' && (part.name || part.tool)) {
        return {
          tool: String(part.name ?? part.tool ?? 'tool'),
          detail: summarizeInput(part.state?.input),
        }
      }
      if (part.type === 'text' && part.text) {
        return { tool: '', detail: part.text }
      }
    }
  }
  return { tool: '', detail: '' }
}

// ---------------------------------------------------------------- 行构建

/**
 * 把一批子会话变成面板行。
 *
 * `activities` 是外部（组件里）缓存好的「谁在跑什么」，避免这里再拉消息；
 * 不给就是空，界面只显示会话本身的信息。
 *
 * 排序：跑动的排最前，跑得久的更前（卡住的子智能体一眼能看见）；结束的按耗时倒序。
 */
export function buildSubagentRows(options: {
  sessions: SubagentSession[]
  now: number
  activities?: Record<string, Activity>
}): SubagentRow[] {
  const { sessions, now, activities } = options
  if (!Array.isArray(sessions)) return []

  const rows: SubagentRow[] = sessions.map((session) => {
    const state = stateOf(session, now)
    const activity = activities?.[session.id]
    return {
      id: session.id,
      short: shortID(session.id),
      title: (session.title ?? '').trim() || '（未命名子任务）',
      agent: session.agent ?? 'subagent',
      depth: session.depth ?? 1,
      state,
      mark: stateMark(state),
      elapsedMs: elapsedOf(session, now),
      outTokens: outTokensOf(session),
      inTokens: inTokensOf(session),
      cost: session.cost ?? 0,
      tool: activity?.tool ?? '',
      detail: activity?.detail ?? '',
    }
  })

  rows.sort((left, right) => {
    const leftRunning = left.state === 'running'
    const rightRunning = right.state === 'running'
    if (leftRunning !== rightRunning) return leftRunning ? -1 : 1
    if (leftRunning) return right.elapsedMs - left.elapsedMs
    return right.elapsedMs - left.elapsedMs
  })
  return rows
}

export function shortID(id: string): string {
  const tail = id.includes('_') ? id.slice(id.lastIndexOf('_') + 1) : id
  return tail.slice(-6)
}

// ---------------------------------------------------------------- 汇总

export type SubagentSummary = {
  total: number
  running: number
  /** 所有子会话合计输出 token */
  outTokens: number
  /** 所有子会话合计花费 */
  cost: number
  /** 面板标题那一行文案 */
  text: string
}

export function summarize(rows: SubagentRow[]): SubagentSummary {
  const total = rows.length
  const running = rows.filter((row) => row.state === 'running').length
  const outTokens = rows.reduce((sum, row) => sum + row.outTokens, 0)
  const cost = rows.reduce((sum, row) => sum + row.cost, 0)
  const text =
    total === 0
      ? ''
      : running > 0
        ? `${running} 个在跑 / 共 ${total} 个子智能体`
        : `共 ${total} 个子智能体 · 全部结束`
  return { total, running, outTokens, cost, text }
}

// ---------------------------------------------------------------- 格式化

export function fmtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function fmtCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

/**
 * 卡住判定：跑动中但超过阈值没动静。
 *
 * 阈值默认 5 分钟：正常子智能体一次工具调用很少超过这个时间，
 * 超了大概率是卡在等输入 / 死循环 / 网络重试。
 */
export const STUCK_MS = 5 * 60 * 1000

export function isStuck(row: SubagentRow, now: number, stuckMs = STUCK_MS): boolean {
  if (row.state !== 'running') return false
  return row.elapsedMs > stuckMs
}
