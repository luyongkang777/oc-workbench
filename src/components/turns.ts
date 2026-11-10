/**
 * 会话消息 → 一轮一轮的纯计算（不碰 React，方便单测）。
 *
 * opencode 的消息接口是**倒序**返回的（最新在前），这里先反转成时间正序。
 * 一轮 = 一条用户消息 + 之后的 assistant 消息（text / reasoning / tool 段）。
 */
import type { ChatMessage, MessageFile, MessagePart } from '../api/chat'

export type ToolInfo = {
  name: string
  status: string
  detail: string
}

export type Turn = {
  id: string
  user?: string
  /** 这条用户消息带的附件（图片/文件） */
  files: MessageFile[]
  texts: string[]
  tools: ToolInfo[]
  /** 思考段全文（多段用空行分开） */
  reasoning: string
  /** 是否仍在思考：有 reasoning 段还没写 completed */
  reasoningActive: boolean
  /** 已完成的思考耗时（毫秒）；没有 completed 的段不计入 */
  reasoningMs: number
  /** 正在进行的思考段开始时间，用来在界面上走秒 */
  reasoningStartedAt: number | null
}

const DETAIL_LIMIT = 90

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > DETAIL_LIMIT ? `${one.slice(0, DETAIL_LIMIT)}…` : one
}

export function toolDetail(part: MessagePart): string {
  const input = (part.state as { input?: Record<string, unknown> } | undefined)?.input ?? {}
  const pick = (key: string): string => {
    const value = input[key]
    return typeof value === 'string' ? value : ''
  }
  const raw =
    pick('command') ||
    pick('filePath') ||
    pick('path') ||
    pick('pattern') ||
    pick('query') ||
    pick('url') ||
    pick('code') ||
    ''
  return clip(raw)
}

function emptyTurn(id: string): Turn {
  return {
    id,
    files: [],
    texts: [],
    tools: [],
    reasoning: '',
    reasoningActive: false,
    reasoningMs: 0,
    reasoningStartedAt: null,
  }
}

/** 把消息按「用户提问」切成一轮一轮。 */
export function groupTurns(messages: ChatMessage[]): Turn[] {
  const ordered = [...messages].reverse()
  const turns: Turn[] = []

  for (const message of ordered) {
    if (message.type === 'idle') continue

    if (message.type === 'user') {
      const turn = emptyTurn(message.id)
      turn.user = message.text ?? ''
      turn.files = Array.isArray(message.files) ? message.files : []
      turns.push(turn)
      continue
    }

    if (message.type !== 'assistant') continue

    let turn = turns[turns.length - 1]
    if (!turn || turn.user === undefined) {
      // 开头没有用户消息（例如历史被截断）时补一个空轮次，别把内容丢掉
      turn = emptyTurn(message.id)
      turns.push(turn)
    }

    const done = typeof message.time?.completed === 'number'
    for (const part of message.content ?? []) {
      if (part.type === 'text' && part.text) {
        turn.texts.push(part.text)
      } else if (part.type === 'reasoning') {
        const text = typeof part.text === 'string' ? part.text.trim() : ''
        if (text) {
          turn.reasoning = turn.reasoning ? `${turn.reasoning}\n\n${text}` : text
        }
        const created = part.time?.created
        const completed = part.time?.completed
        if (typeof created === 'number' && typeof completed === 'number') {
          turn.reasoningMs += Math.max(0, completed - created)
        } else if (!done && typeof created === 'number') {
          turn.reasoningActive = true
          if (turn.reasoningStartedAt === null || created < turn.reasoningStartedAt) {
            turn.reasoningStartedAt = created
          }
        }
      } else if (part.type === 'tool') {
        turn.tools.push({
          name: part.name ?? '工具',
          status: part.state?.status ?? 'unknown',
          detail: toolDetail(part),
        })
      }
    }
  }

  return turns
}

/** 思考时长的展示文本：进行中按当前时间走秒，结束用累计耗时。 */
export function reasoningLabel(turn: Pick<Turn, 'reasoningActive' | 'reasoningMs' | 'reasoningStartedAt'>, now = Date.now()): string {
  if (turn.reasoningActive && turn.reasoningStartedAt) {
    const seconds = Math.max(1, Math.round((now - turn.reasoningStartedAt) / 1000))
    return `思考中… ${seconds}s`
  }
  const seconds = Math.round(turn.reasoningMs / 1000)
  if (seconds >= 1) return `思考过程 ${seconds}s`
  return '思考过程'
}
