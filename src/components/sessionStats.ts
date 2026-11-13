/**
 * 会话统计（纯计算，不碰 React，方便单测）。
 *
 * 输入框下面那两个读数——「1 轮 4 步 · 218 tok/s」和「38.3K tok · 缓存命中 67%」——
 * 全部在这里算出来。口径：
 *
 * - 轮 = 一条用户消息；步 = 一条 assistant 消息（opencode 每个 step 就是一条）。
 * - 缓存命中率 = cacheRead / (input + cacheRead + cacheWrite)。
 *   分母必须把 cacheRead 自己算进去：只拿 input 当分母，全命中缓存的请求会
 *   变成 0/0（显示成 100% 或 NaN）；把 cacheRead 漏掉又会现出 0%。
 * - 输出速度只除以「模型真正在写字」的时间：从首个 part 落地到消息完成。
 *   用的是 created→completed 的整段墙钟的话，调了十次工具的那一轮会被摊成
 *   个位数 tok/s，看着像模型坏了。
 * - 模型用时 = TTFT + 生成时间；工具用时单独累计 tool part 的执行区间，
 *   两者不重叠，加起来才接近那一轮的墙钟。
 */
import type { ChatMessage, MessagePart } from '../api/chat'

export type SessionStats = {
  /** 用户提问条数 */
  turns: number
  /** assistant 消息（step）条数 */
  steps: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** input + output + cacheRead + cacheWrite */
  total: number
  /** 0-100；没有输入侧 token 时为 null */
  cacheHit: number | null
  /** 模型用时（毫秒）：TTFT + 生成时间，已完成的 step 之和 */
  modelMs: number
  /** 工具调用用时（毫秒）：tool part 的执行区间之和 */
  toolMs: number
  /** 首 token 平均延迟（毫秒） */
  ttftMs: number | null
  /**
   * 输出速度（token/秒）。
   *
   * 只按「本轮」算，不按整个会话：长会话动辄几百步、几亿 token，累计平均
   * 摊到新的一步上连小数点都动不了，读数看起来就是死的。
   */
  tps: number | null
  /** 本轮（最后一次提问之后）的步数 */
  turnSteps: number
  /** 本轮已产出的输出 token（正文，不含思考） */
  turnOutput: number
  /** 本轮产出的思考 token */
  turnReasoning: number
  /** 本轮模型用时（毫秒） */
  turnMs: number
  /** 还有 step 没跑完 */
  running: boolean
  /** 拿到过任何数据 */
  known: boolean
}

function pos(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 中日韩文字：1 字约等于 1 个 token。 */
function isCJK(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // 日文假名
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 基本汉字
    (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
    (code >= 0xac00 && code <= 0xd7af) // 谚文
  )
}

/**
 * 没有精确 token 数时按文本估算。
 *
 * 中文按 1 字 1 token、其余按 4 字符 1 token。只服务于流式过程中的读数：
 * 这一步跑完、服务端给了真实 tokens，就用真实值整体替换。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let rest = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    // 代理对（emoji 等）按一个字符算，别把高低位各计一次
    if (code >= 0xd800 && code <= 0xdbff) {
      rest += 1
      i += 1
      continue
    }
    if (isCJK(code)) cjk += 1
    else rest += 1
  }
  return cjk + Math.round(rest / 4)
}

/** 一条消息里已落地的文字（正文 + 思考）对应的估算输出量。 */
export function estimatePartsTokens(parts: MessagePart[]): number {
  let total = 0
  for (const part of parts) {
    if (part.type !== 'text' && part.type !== 'reasoning') continue
    total += estimateTextTokens(part.text ?? '')
  }
  return total
}

type MessageFacts = {
  /** 这条消息里所有 tool part 的执行时长之和（展示「工具用时」用） */
  toolMs: number
  /**
   * 每个工具的执行区间。
   *
   * 扣生成时间只能扣和「模型输出时段」重叠的那一段：实测工具多数是在
   * streamed 之后才执行的，整段减掉会把生成时间减成 0。
   */
  toolSpans: Array<[number, number]>
  /** 首个内容段（text / reasoning）的落地时间：TTFT 的终点，也是计速起点 */
  firstAt: number | undefined
  /** 这一步确实有文字（正文或思考）：没有的话就是纯工具步，不参与计速 */
  hasContent: boolean
  /** 这步一开始就调工具（第一个 part 是 tool）：TTFT 不该算它前面的等待 */
  leadingTool: boolean
  /** 还在跑的工具的最早开始时间：用来把它已经占掉的时间从生成时间里扣出去 */
  runningToolStart: number | undefined
  /** 没有精确 tokens 时的估算值，惰性计算 */
  est?: number
}

/**
 * 单条消息自身的 part 统计。
 *
 * 挂在消息对象上用 WeakMap 缓存：流式时只有正在写的那一条会换成新对象，
 * 其余消息一直命中；对象被回收时缓存也跟着走，不会泄漏。
 *
 * 这一层把「每个 delta 重扫全部历史 parts」的 O(总字符数) 压回常数级 ——
 * 长会话流式 42k 字那一步，统计累计从 1272ms 降到十几毫秒。
 */
const factsCache = new WeakMap<ChatMessage, MessageFacts>()

function partFacts(message: ChatMessage): MessageFacts {
  const hit = factsCache.get(message)
  if (hit) return hit

  const parts = Array.isArray(message.content) ? message.content : []
  let toolMs = 0
  const toolSpans: Array<[number, number]> = []
  let firstAt: number | undefined
  let hasContent = false
  let runningToolStart: number | undefined
  for (const part of parts) {
    if (part.type === 'tool') {
      // 实测字段在 part.time 上：created（发起）→ ran（开始执行）→ completed（结束）。
      // state.time 是旧结构，两处都认，否则工具时间永远算成 0，生成时间会把它一起吞掉。
      const start = part.time?.created ?? part.state?.time?.start
      const end = part.time?.completed ?? part.time?.ran ?? part.state?.time?.end
      if (typeof start === 'number' && typeof end === 'number' && end >= start) {
        toolMs += end - start
        toolSpans.push([start, end])
      } else if (typeof start === 'number') {
        // 工具跑着的时候也要扣：不扣的话「等工具」的时间会被当成模型在写，
        // 速度一路往下掉，看着像模型卡住了
        if (runningToolStart === undefined || start < runningToolStart) runningToolStart = start
      }
      continue
    }
    if (part.type !== 'text' && part.type !== 'reasoning') continue
    if ((part.text ?? '').length > 0) hasContent = true
    // text part 实测没有 time（只有 reasoning 和 tool 有），拿不到就交给调用方退回
    // 消息级 created → streamed 兜底
    const at = part.time?.created
    if (typeof at !== 'number') continue
    if (firstAt === undefined || at < firstAt) firstAt = at
  }

  const facts: MessageFacts = {
    toolMs,
    toolSpans,
    firstAt,
    hasContent,
    leadingTool: parts[0]?.type === 'tool',
    runningToolStart,
  }
  factsCache.set(message, facts)
  return facts
}

/** 估算输出量：同一条消息只算一次。 */
function estimateForMessage(message: ChatMessage, facts: MessageFacts): number {
  if (facts.est === undefined) {
    facts.est = estimatePartsTokens(Array.isArray(message.content) ? message.content : [])
  }
  return facts.est
}

export function emptyStats(): SessionStats {
  return {
    turns: 0,
    steps: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cacheHit: null,
    modelMs: 0,
    toolMs: 0,
    ttftMs: null,
    tps: null,
    turnSteps: 0,
    turnOutput: 0,
    turnReasoning: 0,
    turnMs: 0,
    running: false,
    known: false,
  }
}

/**
 * 从消息列表算整个会话的累计统计。
 *
 * `now` 只用于「还在跑的那一步」估算生成时长，单测时固定传值即可复现。
 */
export function computeSessionStats(messages: ChatMessage[], now = Date.now()): SessionStats {
  let turns = 0
  let steps = 0
  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0
  let toolMs = 0
  let running = false

  // 速度与延迟只累计「有进度」的 step
  let genMs = 0
  let ttftSum = 0
  let ttftCount = 0
  /**
   * 最近一个「有文字」的 step 的速率（输出 token ÷ 它的生成时长）。
   *
   * 速度取这一步，不取整轮平均：一轮里工具多、空转多，平均下来数字很低，
   * 和 opencode 那边显示的不是一回事。opencode 给的是「模型此刻写得多快」，
   * 也就是某一步的速率。
   */
  let lastRate: { produced: number; genMs: number } | null = null

  // 「本轮」= 倒序列表里第一条用户消息之前的那些 step。
  // 速度按这一份算：945 步、3 亿 token 的会话，累计平均摊到新一步上连
  // 小数点都动不了，读数看着就是死的。
  let turnEnd = messages.length
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].type === 'user') {
      turnEnd = i
      break
    }
  }
  let turnSteps = 0
  let turnOutput = 0
  let turnReasoning = 0
  let turnGenMs = 0
  let turnTtft = 0

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const inTurn = index < turnEnd
    if (message.type === 'user') {
      // 纯附件（只贴图不说话）也算一轮
      const hasText = (message.text ?? '').trim().length > 0
      const hasFiles = (message.files?.length ?? 0) > 0
      if (hasText || hasFiles) turns += 1
      continue
    }
    if (message.type !== 'assistant') continue

    const parts = Array.isArray(message.content) ? message.content : []
    const tokens = message.tokens
    // 骨架（step.started 刚插进来的空消息）也算一步：它确实是已经开始的一步。
    // 不算的话新一步开始后读数一动不动，等这一步结束才突然跳，看着像没在跑。
    if (parts.length === 0 && !tokens && typeof message.time?.created !== 'number') continue

    steps += 1
    if (inTurn) turnSteps += 1
    input += pos(tokens?.input)
    // 服务端只在 step 结束时才给 tokens。流式过程中拿不到就别干等着：
    // 按已经落地的文字估算一份，这一步结束拿到真实值后自动替换。
    // output 为 0 但已经有文字时也走估算——有些 step 一开始就带着
    // `tokens: { output: 0 }`，只认这个字段同样会把读数钉死。
    const facts = partFacts(message)
    const piece = pos(tokens?.output) > 0 ? pos(tokens?.output) : estimateForMessage(message, facts)
    const think = pos(tokens?.reasoning)
    output += piece
    if (inTurn) turnOutput += piece
    reasoning += think
    if (inTurn) turnReasoning += think
    cacheRead += pos(tokens?.cache?.read)
    cacheWrite += pos(tokens?.cache?.write)

    const started = message.time?.created
    const completed = message.time?.completed
    const streamed = message.time?.streamed
    if (typeof completed !== 'number') running = true

    // 工具用时与首段落地时间都来自缓存：这两项只依赖消息自身，与全局无关。
    toolMs += facts.toolMs
    const firstAt = facts.firstAt

    // TTFT 只统计「开口前没调工具」的步骤：先调工具再说话，那段等待是工具
    // 时间，算进首 token 延迟会把 TTFT 抬成几十秒
    if (
      !facts.leadingTool &&
      typeof started === 'number' &&
      firstAt !== undefined &&
      firstAt >= started
    ) {
      ttftSum += firstAt - started
      ttftCount += 1
      if (inTurn) turnTtft += firstAt - started
    }

    // 生成时间 = 模型开始写字 → 模型停止输出（streamed）。
    //
    // 用 streamed 而不是 completed：completed 是这一步彻底结束，后面还挂着
    // 工具执行；拿它当终点会把「等工具」算成模型在写，速度被摊成个位数。
    // 起点优先用首个内容段的 created（reasoning 有），text part 没有时间，
    // 退回消息 created —— 会多算一点首 token 延迟，但比多算整段工具时间准得多。
    // 纯工具步（没有任何文字）不参与计速：分子里也没有它的输出。
    if (facts.hasContent) {
      const end = typeof streamed === 'number' ? streamed : typeof completed === 'number' ? completed : now
      const begin = firstAt ?? started
      if (typeof begin === 'number' && end > begin) {
        // 只扣和 [begin, end] 这段重叠的工具时间。工具多数在 streamed 之后执行，
        // 整段减会把生成时间减成 0。
        let toolInSpan = 0
        for (const span of facts.toolSpans) {
          const overlap = Math.min(end, span[1]) - Math.max(begin, span[0])
          if (overlap > 0) toolInSpan += overlap
        }
        // 还在跑的工具：只扣到 end 为止已经占用的部分
        if (facts.runningToolStart !== undefined && end > facts.runningToolStart) {
          const from = Math.max(begin, facts.runningToolStart)
          if (end > from) toolInSpan += end - from
        }
        const gen = Math.max(0, end - begin - toolInSpan)
        genMs += gen
        if (inTurn) {
          turnGenMs += gen
          // 倒序列表：第一次遇到的就是最新的那一步，取它的速率
          if (lastRate === null && gen > 0) {
            lastRate = { produced: piece + think, genMs: gen }
          }
        }
      }
    }
  }

  const total = input + output + cacheRead + cacheWrite
  const cacheBase = input + cacheRead + cacheWrite
  const cacheHit = cacheBase > 0 ? Math.min(100, (cacheRead / cacheBase) * 100) : null
  const ttftMs = ttftCount > 0 ? ttftSum / ttftCount : null
  // 速度取最近一个带文字步骤的速率（对应 opencode 状态栏的口径），
  // 不是整轮平均：一轮里工具和空转占大头，平均下来数字会低一个量级。
  // 分子含 reasoning：推理模型一步里思考 token 往往比正文多一个数量级。
  const tps = lastRate && lastRate.genMs > 0 ? lastRate.produced / (lastRate.genMs / 1000) : null

  return {
    turns,
    steps,
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total,
    cacheHit,
    // 模型用时 = 等首 token + 写正文；没有 TTFT 数据时退化成生成时间
    modelMs: genMs + ttftSum,
    toolMs,
    ttftMs,
    tps,
    turnSteps,
    turnOutput,
    turnReasoning,
    turnMs: turnGenMs + turnTtft,
    running,
    known: total > 0 || steps > 0,
  }
}

/** 速度：整数，不带小数。400 以上也照写，不换算成 k。 */
export function formatRate(tps: number | null): string {
  if (tps === null || !Number.isFinite(tps) || tps <= 0) return ''
  const n = tps >= 100 ? Math.round(tps) : Math.round(tps * 10) / 10
  return `${n} tok/s`
}

/** 百分比：四舍五入到整数；null → 空串（调用方据此省略这一段）。 */
export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return ''
  return `${Math.round(value)}%`
}

/**
 * 统计栏里的 token 总量：保留一位小数。
 *
 * contextUsage 的 formatTokens 会把 38300 压成「38k」——那是给百分比条用的，
 * 这里读数要能看出量级变化，38.3k / 393k / 4.1M 才有信息量。
 */
export function formatTokenTotal(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  const trim = (n: number, unit: string) => `${String(n.toFixed(1)).replace(/\.0$/, '')}${unit}`
  if (value >= 1_000_000) return trim(value / 1_000_000, 'M')
  if (value >= 1000) return trim(value / 1000, 'k')
  return String(Math.round(value))
}

/**
 * 统计栏里的短时长：420ms / 4.2s / 1分12秒 / 1小时3分。
 * 和 turns.ts 的 formatSpan 不同——那边是中文长句，这边要挤进一行。
 */
export function formatStatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  if (minutes < 60) return rest ? `${minutes}分${rest}秒` : `${minutes}分`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins ? `${hours}小时${mins}分` : `${hours}小时`
}

/** 第一行读数：「1 轮 4 步 · 218 tok/s」，没有速度时只剩前半段。 */
export function activitySummary(stats: SessionStats): string {
  const counts = stats.turns > 0 || stats.steps > 0 ? `${stats.turns} 轮 ${stats.steps} 步` : '0 轮 0 步'
  const rate = formatRate(stats.tps)
  return rate ? `${counts} · ${rate}` : counts
}

/** 第二行读数：「38.3K tok · 缓存命中 67%」，命中率没有时只剩前半段。 */
export function usageSummary(stats: SessionStats, tokens: string): string {
  const percent = formatPercent(stats.cacheHit)
  return percent ? `${tokens} tok · 缓存命中 ${percent}` : `${tokens} tok`
}

/** 明细浮层的标题行：「1 轮 4 步」，和读数第一段同口径。 */
export function countsLabel(stats: SessionStats): string {
  return `${stats.turns} 轮 ${stats.steps} 步`
}
