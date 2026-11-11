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

/**
 * 一轮里的一段输出，按消息 part 的原始顺序排列。
 * 渲染层必须按这个顺序走，才能做到「思考 → 说话 → 工具 → 思考 → 说话」交错，
 * 而不是把同类型的内容合并成三大块。
 */
export type TurnBlock =
  | { kind: 'reasoning'; text: string; active: boolean; ms: number; startedAt: number | null; key: string }
  | { kind: 'text'; text: string; key: string }
  | { kind: 'tools'; tools: ToolInfo[]; key: string }

export type Turn = {
  id: string
  user?: string
  /** 这条用户消息带的附件（图片/文件） */
  files: MessageFile[]
  /** 按原始顺序排列的段落（渲染用这个） */
  blocks: TurnBlock[]
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
    blocks: [],
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
    let blockIndex = 0
    const nextKey = () => `${message.id}:${blockIndex++}`

    for (const part of message.content ?? []) {
      if (part.type === 'text' && part.text) {
        turn.texts.push(part.text)
        // 连续的 text 段合成一段话；中间隔了思考或工具就另起一块
        const prev = turn.blocks[turn.blocks.length - 1]
        if (prev && prev.kind === 'text') {
          prev.text = prev.text ? `${prev.text}\n\n${part.text}` : part.text
        } else {
          turn.blocks.push({ kind: 'text', text: part.text, key: nextKey() })
        }
      } else if (part.type === 'reasoning') {
        const text = typeof part.text === 'string' ? part.text.trim() : ''
        if (text) {
          turn.reasoning = turn.reasoning ? `${turn.reasoning}\n\n${text}` : text
        }
        const created = part.time?.created
        const completed = part.time?.completed

        let ms = 0
        let active = false
        let startedAt: number | null = null

        if (typeof created === 'number' && typeof completed === 'number') {
          ms = Math.max(0, completed - created)
          turn.reasoningMs += ms
        } else if (!done && typeof created === 'number') {
          active = true
          startedAt = created
          turn.reasoningActive = true
          if (turn.reasoningStartedAt === null || created < turn.reasoningStartedAt) {
            turn.reasoningStartedAt = created
          }
        }

        // 每段思考单独成块，绝不合并：第一次思考 → 说话 → 工具 → 第二次思考，各占各的位置
        if (text || active) {
          turn.blocks.push({ kind: 'reasoning', text, active, ms, startedAt, key: nextKey() })
        }
      } else if (part.type === 'tool') {
        const info = {
          name: part.name ?? '工具',
          status: part.state?.status ?? 'unknown',
          detail: toolDetail(part),
        }
        turn.tools.push(info)
        // 连着调的工具收成一组，前面是思考或说话就另起一组
        const prev = turn.blocks[turn.blocks.length - 1]
        if (prev && prev.kind === 'tools') {
          prev.tools.push(info)
        } else {
          turn.blocks.push({ kind: 'tools', tools: [info], key: nextKey() })
        }
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

/**
 * 两轮内容是否完全一样。
 *
 * `groupTurns` 每次都造新对象，渲染层光比引用永远不相等，
 * 于是任意一条消息变化都会让整个列表重渲染。这个比较让没变的轮次跳过。
 */
export function sameTurn(a: Turn, b: Turn): boolean {
  if (a === b) return true
  if (a.id !== b.id || a.user !== b.user) return false

  if (a.files.length !== b.files.length) return false
  for (let i = 0; i < a.files.length; i++) {
    if (a.files[i]?.name !== b.files[i]?.name || a.files[i]?.data !== b.files[i]?.data) return false
  }

  if (a.blocks.length !== b.blocks.length) return false
  for (let i = 0; i < a.blocks.length; i++) {
    const x = a.blocks[i]
    const y = b.blocks[i]
    if (x.kind !== y.kind || x.key !== y.key) return false

    if (x.kind === 'text' && y.kind === 'text') {
      if (x.text !== y.text) return false
    } else if (x.kind === 'reasoning' && y.kind === 'reasoning') {
      if (x.text !== y.text || x.active !== y.active || x.ms !== y.ms) return false
    } else if (x.kind === 'tools' && y.kind === 'tools') {
      if (x.tools.length !== y.tools.length) return false
      for (let j = 0; j < x.tools.length; j++) {
        const tx = x.tools[j]
        const ty = y.tools[j]
        if (tx.name !== ty.name || tx.status !== ty.status || tx.detail !== ty.detail) return false
      }
    }
  }

  return true
}
