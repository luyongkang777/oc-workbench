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
  /**
   * 压缩摘要全文。
   *
   * 服务端把压缩结果存成一条 `type: "compaction"` 的消息，正文不在 content 里，
   * 而在 `message.summary`。历史被重写之后，这段摘要是唯一能说明「之前聊了什么」
   * 的东西，必须渲染出来。
   */
  summary?: string
  /** 摘要生成时间（毫秒），用于标题上的时间戳 */
  summaryAt?: number
  /** 这一轮的开始时间（毫秒）：用户提问的 time.created，缺省时退回首条回复的 created */
  startedAt?: number
  /** 这一轮的结束时间（毫秒）：本轮最后一条回复的 time.completed；还在生成时为空 */
  endedAt?: number
  /**
   * 压缩失败原因。服务端会回 200 但在 compaction 消息上带 error
   * （例如「Nothing to compact yet」），这种也要在历史里留一条，别静默吞掉。
   */
  summaryError?: string
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

type TurnGroup = {
  turns: Turn[]
  /** 每个 turn 覆盖的消息 id（时间正序），增量重算时用来判断这一段是不是原封未动 */
  ids: string[][]
}

/** 把已经按时间正序排好的消息切成一轮一轮，并记录每轮覆盖的消息 id。 */
function buildTurns(ordered: ChatMessage[]): TurnGroup {
  const turns: Turn[] = []
  const ids: string[][] = []

  for (const message of ordered) {
    if (message.type === 'idle') continue

    if (message.type === 'compaction') {
      // 压缩节点：正文在 message.summary，content 是空的。
      // 摘要本身要占一轮显示出来，否则压缩之后这段历史等于凭空消失。
      const text = typeof message.summary === 'string' ? message.summary.trim() : ''
      const failure = message.error?.message?.trim() ?? ''
      // 既没摘要也没错误的空节点（服务端占位）不占位置
      if (!text && !failure) continue
      const turn = emptyTurn(message.id)
      if (text) turn.summary = text
      if (failure) turn.summaryError = failure
      const at = message.time?.completed ?? message.time?.created
      if (typeof at === 'number') turn.summaryAt = at
      if (typeof message.time?.created === 'number') turn.startedAt = message.time.created
      if (typeof message.time?.completed === 'number') turn.endedAt = message.time.completed
      turns.push(turn)
      ids.push([message.id])
      continue
    }

    if (message.type === 'user') {
      const turn = emptyTurn(message.id)
      turn.user = message.text ?? ''
      turn.files = Array.isArray(message.files) ? message.files : []
      if (typeof message.time?.created === 'number') turn.startedAt = message.time.created
      turns.push(turn)
      ids.push([message.id])
      continue
    }

    if (message.type !== 'assistant') continue

    let turn = turns[turns.length - 1]
    if (!turn || turn.user === undefined) {
      // 开头没有用户消息（例如历史被截断）时补一个空轮次，别把内容丢掉
      turn = emptyTurn(message.id)
      turns.push(turn)
      ids.push([message.id])
    } else {
      ids[ids.length - 1].push(message.id)
    }

    const done = typeof message.time?.completed === 'number'
    // 轮次时间：起点优先用用户提问时间，没有就用首条回复的 created；
    // 终点取本轮最后一条回复的 completed（一轮可能有多条 assistant 消息）
    if (turn.startedAt === undefined && typeof message.time?.created === 'number') {
      turn.startedAt = message.time.created
    }
    if (typeof message.time?.completed === 'number') {
      if (turn.endedAt === undefined || message.time.completed > turn.endedAt) {
        turn.endedAt = message.time.completed
      }
    }
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

  return { turns, ids }
}

/** 把消息按「用户提问」切成一轮一轮。 */
export function groupTurns(messages: ChatMessage[]): Turn[] {
  return buildTurns([...messages].reverse()).turns
}

/** 增量重算的缓存：上一次的成品 + 它吃掉的 id 段 + 当时那批消息对象的引用。 */
export type TurnsCache = {
  turns: Turn[]
  ids: string[][]
  /** 时间正序的消息数组（引用比较用） */
  ordered: ChatMessage[]
}

/**
 * 增量版 groupTurns。
 *
 * 流式输出时每个 delta 都会让 messages 变成新数组，但除正在写的那一条之外，
 * 其余消息对象的**引用是不变的**（appendText / mergeMessages 都只替换目标消息）。
 * 所以只要上一轮某个 turn 覆盖的那段消息引用全部没变，就能直接复用上一轮的 Turn
 * 对象 —— 渲染层 sameTurn 立刻命中，等于整段历史零重建。
 *
 * 全量算 1000 轮约 1.8ms/次，30~50 delta/s 就是 6~9% 的主线程；增量后只剩
 * 最后一轮的构建成本（约 0.02ms）。
 */
export function groupTurnsIncremental(
  prev: TurnsCache | null,
  messages: ChatMessage[],
): TurnsCache {
  const ordered: ChatMessage[] = []
  for (let i = messages.length - 1; i >= 0; i -= 1) ordered.push(messages[i])

  if (!prev || prev.ids.length === 0) {
    const built = buildTurns(ordered)
    return { ...built, ordered }
  }

  // 上一轮每个 turn 在它那份 ordered 里的起点位置
  const startOf: number[] = []
  let cursor = 0
  for (const seg of prev.ids) {
    startOf.push(cursor)
    cursor += seg.length
  }

  /*
   * 从头逐轮比对：整段原封不动就复用，遇到第一处不同就停下，
   * 剩下的（通常只有最后一轮）整段重算。
   *
   * 不做「中间挖洞、后面接着复用」：那样切出来的段可能从 assistant 开始，
   * 归属会和全量算法不一致（assistant 应该并进它前面那一轮）。
   * 流式输出只改最新一轮，前缀复用已经吃掉了全部收益；
   * 往上翻页这种低频操作退化成一次全量重算，值得。
   */
  const turns: Turn[] = []
  const ids: string[][] = []
  let i = 0
  for (let slot = 0; slot < prev.ids.length; slot += 1) {
    const seg = prev.ids[slot]
    if (!sameSegment(prev.ordered, startOf[slot], ordered, i, seg.length)) break
    if (ordered[i]?.id !== seg[0]) break
    turns.push(prev.turns[slot])
    ids.push(seg)
    i += seg.length
  }

  if (i < ordered.length) {
    const rebuilt = buildTurns(ordered.slice(i))
    turns.push(...rebuilt.turns)
    ids.push(...rebuilt.ids)
  }

  return { turns, ids, ordered }
}

/** 两段消息是否逐条同引用（同引用 ⇒ 内容一定没变）。 */
function sameSegment(
  a: ChatMessage[],
  aFrom: number,
  b: ChatMessage[],
  bFrom: number,
  length: number,
): boolean {
  if (aFrom + length > a.length || bFrom + length > b.length) return false
  for (let k = 0; k < length; k += 1) {
    if (a[aFrom + k] !== b[bFrom + k]) return false
  }
  return true
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

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * 时间戳展示：当天只给 `HH:MM`，不是当天带上 `MM-DD`，跨年再带年份。
 * 历史翻回去看的时候，光有几点钟分不清是哪天。
 */
export function formatClock(at: number, now = Date.now()): string {
  const date = new Date(at)
  const today = new Date(now)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  ) {
    return clock
  }
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return date.getFullYear() === today.getFullYear() ? `${day} ${clock}` : `${date.getFullYear()}-${day} ${clock}`
}

/** 完整时间，给 title 用：2026-11-12 19:42:31 */
export function formatDateTime(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`
}

/** 一段耗时：12 秒 / 5 分 32 秒 / 1 小时 3 分 */
export function formatSpan(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`
}

/**
 * 一轮的时间说明：起点、终点、耗时。
 * 还在生成（没有 endedAt）时只给起点，界面上另有「模型思考中」提示。
 */
export function turnTimeLabel(
  turn: Pick<Turn, 'startedAt' | 'endedAt'>,
  now = Date.now(),
): { start: string; end: string; span: string } | null {
  if (turn.startedAt === undefined && turn.endedAt === undefined) return null
  const start = turn.startedAt === undefined ? '' : formatClock(turn.startedAt, now)
  const end = turn.endedAt === undefined ? '' : formatClock(turn.endedAt, now)
  const span =
    turn.startedAt !== undefined && turn.endedAt !== undefined && turn.endedAt >= turn.startedAt
      ? formatSpan(turn.endedAt - turn.startedAt)
      : ''
  return { start, end, span }
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
  // 摘要消息只有这一段正文：内容变了必须重渲染
  if (a.summary !== b.summary || a.summaryAt !== b.summaryAt) return false
  if (a.summaryError !== b.summaryError) return false
  // 时间戳变化也要重渲染：结束时间是在流式过程中才补上的，漏比就永远显示不出来
  if (a.startedAt !== b.startedAt || a.endedAt !== b.endedAt) return false

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
