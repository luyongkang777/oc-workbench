import { withBase } from './base.ts'
/** 会话与事件流（T5）。认证 token 从 window.__OC_TOKEN 读，和 client.ts 一致。 */

/**
 * 会话上暂存的回滚边界（服务端 session.revert）。
 *
 * stage 只是「标记从哪条消息开始回撤」，消息还在库里、可以 clear 取消；
 * commit 才真正删掉这条及其之后的消息。工作台用 stage 做「回撤预览」，
 * 用户改完重新发送时由服务端（或我们显式 commit）落地。
 */
export type SessionRevert = {
  messageID: string
  partID?: string
  snapshot?: string
  /** 回滚涉及的文件差异（stage 时传 files=true 才有） */
  files?: { path?: string; status?: string }[]
}

export type SessionInfo = {
  id: string
  title?: string
  /** 有值说明这是某个会话的子智能体（子会话），值是父会话 id */
  parentID?: string
  /** 子会话用的 agent（explore / debug / general …） */
  agent?: string
  time?: { created?: number; updated?: number; busy?: number; idle?: number; archived?: number }
  location?: { directory?: string }
  model?: { id?: string; providerID?: string; variant?: string }
  metadata?: Record<string, unknown>
  /** 会话累计用量（子智能体面板要显示烧了多少） */
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  cost?: number
  /** 上一轮结束时的结局；还在跑时没有 */
  outcome?: 'succeeded' | 'failed' | 'interrupted'
  /** 有值说明这个会话暂存了一次回撤（消息列表应从 messageID 处截断显示） */
  revert?: SessionRevert
}

/**
 * 工作台自己建的会话都在 metadata 里打这个标记。
 * 下拉列表默认只列带标记的会话：opencode CLI、审核脚本自动建的 review/任务会话
 * 会混进同一个目录，切会话时不需要看到它们。
 */
export const WORKBENCH_SOURCE = 'oc-workbench'

/** 工作台里由用户发起的会话（终端会话带 kind: 'terminal'，不算用户会话）。 */
export function isWorkbenchSession(session: SessionInfo): boolean {
  return (
    session.metadata?.source === WORKBENCH_SOURCE && session.metadata?.kind !== 'terminal'
  )
}

/** 终端也会在工作台里建会话，带这个 kind，切换会话时不该被当成用户会话列出来。 */
export function isWorkbenchTerminal(session: SessionInfo): boolean {
  return session.metadata?.source === WORKBENCH_SOURCE && session.metadata?.kind === 'terminal'
}

export type MessagePart = {
  type: string
  text?: string
  tool?: string
  name?: string
  state?: {
    status?: string
    /** 工具入参：toolDetail 从里面挑 command / path 之类的摘要 */
    input?: Record<string, unknown>
    /** 工具执行结果（完成态才有）：每项是 { type: 'text', text } */
    content?: Array<{ type?: string; text?: string }>
    /** 旧版本把执行区间放在这里；新版本在 part.time 上，两处都认 */
    time?: { start?: number; end?: number }
  }
  /**
   * part 自己的时间（实测结构）：
   * - reasoning: created / completed
   * - tool:      created（发起）/ ran（开始执行）/ completed（执行结束）
   * - text:      没有时间
   */
  time?: { created?: number; completed?: number; ran?: number }
}

/**
 * 用户消息里的附件（图片/文件）。
 *
 * 发出去时用 `PromptFile`（`uri` 是 data URL），服务端存下来后回显成
 * `MessageFile`：base64 在 `data` 里，`mime` 标明类型，`name` 是原文件名。
 */
export type MessageFile = {
  /** base64（不带 `data:` 前缀） */
  data?: string
  mime?: string
  name?: string
  uri?: string
  source?: { type?: string; uri?: string }
  description?: string
}

/** 发送附件：opencode 只认 `uri`，实测 data URL 可直接用。 */
export type PromptFile = {
  uri: string
  name?: string
  source?: { type: 'uri'; uri: string }
}

/**
 * 一次调用的 token 用量（opencode 原样返回）。
 *
 * `input` 是没命中缓存的那部分提示词，`cache.read` 是命中缓存的提示词；
 * 两者相加才是这次请求实际带上的上下文规模——上下文用量必须按这个算，
 * 只看 `input` 会把几百 k 的缓存前缀漏掉。
 */
export type MessageTokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export type ChatMessage = {
  id: string
  type: string
  text?: string
  content?: MessagePart[]
  files?: MessageFile[]
  /**
   * - created:   请求发起
   * - streamed:  模型输出结束（此时工具可能还没开始执行）
   * - completed: 这一步彻底结束（含工具执行）
   *
   * 算「模型在写多久」必须用 streamed：拿 completed 会把工具执行时间算进
   * 生成时间，速度直接掉到个位数。
   */
  time?: { created?: number; streamed?: number; completed?: number }
  model?: { id?: string; providerID?: string }
  tokens?: MessageTokens
  /**
   * 压缩摘要。只在 `type: 'compaction'` 的消息上有意义：
   * 服务端把摘要放在这里，`content` 是空的。
   */
  summary?: string
  /**
   * 压缩失败原因。服务端可能回 200 但消息带 error
   * （例如 `compaction.unavailable / Nothing to compact yet`），
   * 不看这个字段就会把失败当成成功。
   */
  error?: { type?: string; message?: string }
}

/** 表单选项（question 工具里的一个可选项）。 */
export type FormOption = {
  value: string
  label: string
  description?: string
}

/** 表单字段：question 工具的单选是 string + options，多选是 multiselect。 */
export type FormField = {
  key: string
  title: string
  description?: string
  /** string | number | integer | boolean | multiselect | select | external */
  type: string
  options?: FormOption[]
  custom?: boolean
  placeholder?: string
  default?: unknown
}

export type FormInfo = {
  id: string
  sessionID: string
  title?: string
  metadata?: Record<string, unknown>
  fields: FormField[]
  state: { status: string; answer?: Record<string, unknown>; message?: string }
}

/** 可切换的 agent（GET /api/agent）。 */
export type AgentInfo = {
  id: string
  name?: string
  description?: string
  mode?: string
  hidden?: boolean
}

/** 斜杠命令（GET /api/command，服务端配置的命令）。 */
export type CommandInfo = {
  name: string
  description?: string
}

/** 切模型/建会话时传的模型引用。variant 是推理档位（high/max…），不传后端会给 default。 */
export type ModelRef = { id: string; providerID: string; variant?: string }

/** 可选模型（GET /api/model）。id + providerID 是切模型时要传的键；variants 是推理档位。 */
export type ModelInfo = {
  id: string
  modelID?: string
  providerID: string
  name?: string
  variants?: { id: string; name?: string; settings?: Record<string, unknown> }[]
  /** 能力上限：context 是上下文窗口，用来算上下文占用百分比 */
  limit?: { context?: number; output?: number }
}

function token(): string {
  return (window as unknown as { __OC_TOKEN?: string }).__OC_TOKEN ?? ''
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  // dev 模式走 Vite 代理（cookie 由代理注入），这时没有 token；
  // 别发空的 x-oc-token，否则会被上游当成带了错误凭据。
  const current = token()
  if (current) headers.set('x-oc-token', current)
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const res = await fetch(withBase(path), { ...init, headers })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/**
 * 会话列表（顶层会话，不含 subagent 子会话）。
 *
 * 后端不支持按目录过滤，且默认只给全局最新的 limit 条；某个目录的最新会话可能排在
 * 第 100 名之后，只取一页再客户端过滤会把它的历史会话全部漏掉，所以这里按
 * cursor.next 翻页收集，最多 MAX_PAGES 页兜底。
 */
const MAX_PAGES = 12

export async function listSessions(limit = 20, root?: string): Promise<SessionInfo[]> {
  const matches: SessionInfo[] = []
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
  const wanted = root ? norm(root) : null
  let cursor: string | undefined

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ limit: String(limit), order: 'desc', parentID: 'null' })
    if (cursor) params.set('cursor', cursor)
    const data = await call<{ data?: SessionInfo[]; cursor?: { next?: string } } | SessionInfo[]>(
      `/api/session?${params.toString()}`
    )
    const list = Array.isArray(data) ? data : (data.data ?? [])
    if (!wanted) return list
    for (const session of list) {
      const dir = session.location?.directory
      // location 缺失的老会话保守放行，避免历史数据凭空消失
      if (!dir || norm(dir) === wanted) matches.push(session)
    }
    cursor = Array.isArray(data) ? undefined : data.cursor?.next
    if (!cursor || list.length === 0) break
  }

  return matches
}

/**
 * 某个会话的直接子会话（只看一层）。
 *
 * 服务端支持 `parentID` 参数，但 `listSessions` 为了只列顶层会话写死了 `parentID=null`；
 * 这里单独走一条，不去动那个函数（改了会影响会话列表和项目灯）。
 */
export async function listChildSessions(parentID: string, limit = 50): Promise<SessionInfo[]> {
  const params = new URLSearchParams({ limit: String(limit), order: 'desc', parentID })
  const data = await call<{ data?: SessionInfo[] } | SessionInfo[]>(
    `/api/session?${params.toString()}`,
  )
  return Array.isArray(data) ? data : (data.data ?? [])
}

/** 子会话树里的一项：多带一个 depth（1 = 直接子智能体）。 */
export type SubagentNode = SessionInfo & { depth: number }

/**
 * 一个会话下的所有子孙会话（自己爬 parentID，最多三层）。
 *
 * 服务端没有「给我整棵树」的接口，只能一层层问。三层足够：子智能体再派孙辈已经
 * 很少见，再深只会把面板刷满、请求数也翻倍。归档的会话就跳过。
 *
 * `skip` 是调用方给的「别再问它孩子」的 id 集合（已经确认过没有孩子的空闲子会话）。
 * 面板每 1.2 秒刷一次，8 个子智能体就是 9 个请求；跳过确认过的能省掉大部分。
 */
export async function listSubagentTree(
  rootID: string,
  maxDepth = 3,
  skip?: Set<string>,
): Promise<SubagentNode[]> {
  const out: SubagentNode[] = []
  const seen = new Set<string>([rootID])
  let frontier: string[] = [rootID]

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const asked = skip ? frontier.filter((id) => !skip.has(id)) : frontier
    // 全被跳过：这一层往下没有新东西可拿，直接收工
    if (asked.length === 0) break
    const lists = await Promise.all(
      asked.map((id) => listChildSessions(id).catch(() => [] as SessionInfo[])),
    )
    const next: string[] = []
    for (const list of lists) {
      for (const session of list) {
        if (!session?.id || seen.has(session.id)) continue
        seen.add(session.id)
        // 归档的会话不显示：那是用户主动收起来的历史
        if (session.time?.archived) continue
        out.push({ ...session, depth })
        next.push(session.id)
      }
    }
    if (next.length === 0) break
    frontier = next
  }

  return out
}

/**
 * 建会话。
 *
 * `title` 只在调用方确实要指定名字时才传。不传时**不要**塞占位标题：
 * 服务端只在「会话还没有标题」的前提下，收到第一条消息后自动生成摘要标题
 * （和 TUI 一样，实测首条消息后二十来秒写入）。先塞一个固定标题，服务端就
 * 再也不会改名了——这正是以前一屏全是「工作台会话」的原因。
 */
export async function createSession(
  root: string,
  title?: string,
  model?: ModelRef,
): Promise<SessionInfo> {
  const body: Record<string, unknown> = {
    model,
    location: { directory: root },
    // metadata 原样存到服务端并在列表接口返回，用它区分「工作台会话」和外部会话
    metadata: { source: WORKBENCH_SOURCE },
  }
  if (title) body.title = title
  const data = await call<{ data?: SessionInfo }>('/api/session', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  const session = data.data
  if (!session?.id) throw new Error('创建会话失败：响应里没有 id')
  return session
}

/** 改名（PATCH 只带 title 时，服务端会保留 metadata，实测不会丢掉工作台标记）。 */
export async function renameSession(sessionID: string, title: string): Promise<void> {
  await call(`/api/session/${encodeURIComponent(sessionID)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
}

/** 旧版本建会话时硬写进去的占位标题，用来认出需要补名字的历史会话。 */
export const LEGACY_PLACEHOLDER_TITLE = '工作台会话'

/**
 * 会话里的第一条用户消息（纯文本）。用来给没有标题的会话起名。
 *
 * 消息列表是最新在前、单页上限 200 条，所以必须沿 cursor 一路翻到最早那页：
 * 页内越靠后越早，取最早一页里最后一条 user 文本。
 * 只翻 maxPages 页：超长会话全翻一遍要几十个请求，而越早的消息越能代表主题，
 * 翻到第 4 页时拿到的已经足够起名。
 */
export async function firstUserText(sessionID: string, maxPages = 4): Promise<string> {
  let cursor: string | undefined
  let earliest = ''
  for (let page = 0; page < maxPages; page += 1) {
    const result = await listMessagePage(sessionID, cursor)
    if (result.messages.length === 0) break
    for (let i = result.messages.length - 1; i >= 0; i -= 1) {
      const message = result.messages[i]
      if (message.type !== 'user') continue
      const text = (message.text ?? '').trim()
      if (text) earliest = text
    }
    if (!result.next) break
    cursor = result.next
  }
  return earliest
}

/**
 * 把首条消息压成一行标题：去掉附件占位（`[Image 1]` 之类）、折叠空白、超长截断。
 * 只是服务端标题还没生成时的兜底，比露一串会话 id 体面。
 */
export function titleFromText(text: string, max = 24): string {
  const line = text
    .replace(/\[[^\]\n]{1,24}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!line) return ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** 服务端单页上限是 200，传更大会 400。 */
const MESSAGE_PAGE_LIMIT = 200
/** 一次最多翻多少页：200 × 50 = 一万条，够长会话用，也防病理会话把内存吃光。 */
const MAX_MESSAGE_PAGES = 50

export type MessagePage = {
  /** 本页消息（服务端倒序：最新在前） */
  messages: ChatMessage[]
  /** 继续往更早翻的游标；空 = 已经到底 */
  next?: string
}

/**
 * 一页消息。
 *
 * 服务端默认只回最新 50 条，且翻页参数只能靠响应里的 `cursor.next`
 * （传 `previous` 或裸 id 都是空/400）。所以调用方必须沿 next 往回走。
 */
export async function listMessagePage(sessionID: string, cursor?: string): Promise<MessagePage> {
  const params = new URLSearchParams({ limit: String(MESSAGE_PAGE_LIMIT) })
  if (cursor) params.set('cursor', cursor)
  const data = await call<{ data?: ChatMessage[]; cursor?: { next?: string } }>(
    `/api/session/${encodeURIComponent(sessionID)}/message?${params.toString()}`,
  )
  return { messages: data.data ?? [], next: data.cursor?.next }
}

/**
 * 拉完整历史。
 *
 * 原来只请求一次、拿默认的 50 条：会话一长，往上一翻就只剩最近 50 条，
 * 表现就是「聊多了之前的记录丢了」。这里沿 cursor.next 一页页翻到最早，
 * 拼成完整的倒序列表；超过页数上限时把游标交回去，界面可以按需续拉。
 */
export async function listMessages(
  sessionID: string,
  maxPages = MAX_MESSAGE_PAGES,
): Promise<{ messages: ChatMessage[]; hasMore: boolean; next?: string }> {
  const all: ChatMessage[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  let hasMore = false

  for (let page = 0; page < maxPages; page += 1) {
    const result = await listMessagePage(sessionID, cursor)
    // 到底时服务端仍会给一个 next，但下一页为空：以「本页为空」为终点
    if (result.messages.length === 0) break
    for (const message of result.messages) {
      if (seen.has(message.id)) continue
      seen.add(message.id)
      all.push(message)
    }
    cursor = result.next
    if (!cursor) break
    if (page === maxPages - 1) hasMore = true
  }

  return { messages: all, hasMore, next: hasMore ? cursor : undefined }
}

/**
 * 合并「最新一页」和「本地已有历史」。
 *
 * 事件触发的刷新只拉最新一页，本地旧消息必须留住，否则每刷一次历史就短一截。
 * 顺序按 `time.created` 倒序（服务端约定最新在前）；没有 created 的
 * （流式事件刚插进来的骨架）当最新处理，免得被挤到列表底部。
 */
/** 消息里 text 段的总字数：判断流式内容有没有被服务端旧快照吃掉。 */
function textLength(message: ChatMessage): number {
  const parts = Array.isArray(message.content) ? message.content : []
  let total = 0
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') total += part.text.length
  }
  return total
}

/**
 * 事件刷新只拉最新一页，服务端快照可能还没包含本地刚流式写出的那段文字。
 * 这一步还没结束（没有 completed）而本地文本更长时保留本地 —— 否则界面会
 * 在两次 delta 之间闪回上一个版本。step 结束后以服务端为准。
 */
function keepLocalStream(local: ChatMessage | undefined, incoming: ChatMessage): ChatMessage {
  if (!local) return incoming
  if (typeof incoming.time?.completed === 'number') return incoming
  if (typeof local.time?.completed === 'number') return incoming
  return textLength(local) > textLength(incoming) ? { ...incoming, content: local.content } : incoming
}

export function mergeMessages(prev: ChatMessage[], fresh: ChatMessage[]): ChatMessage[] {
  const local = new Map<string, ChatMessage>()
  for (const message of prev) local.set(message.id, message)

  const byId = new Map<string, ChatMessage>()
  for (const message of fresh) byId.set(message.id, keepLocalStream(local.get(message.id), message))
  for (const message of prev) if (!byId.has(message.id)) byId.set(message.id, message)
  const list = [...byId.values()]
  list.sort(
    (a, b) =>
      (b.time?.created ?? Number.MAX_SAFE_INTEGER) - (a.time?.created ?? Number.MAX_SAFE_INTEGER),
  )
  return list
}

/** 从当前会话分叉（复制完整历史）。 */
export async function forkSession(sessionID: string): Promise<SessionInfo> {
  const data = await call<{ data?: SessionInfo }>(
    `/api/session/${encodeURIComponent(sessionID)}/fork`,
    { method: 'POST', body: JSON.stringify({}) },
  )
  const session = data.data
  if (!session?.id) throw new Error('fork 失败：响应里没有 id')
  return session
}

/** 会话里等待答复的表单（question 工具）。只返回 pending 的。 */
export async function listForms(sessionID: string): Promise<FormInfo[]> {
  const data = await call<{ data?: FormInfo[] } | FormInfo[]>(
    `/api/session/${encodeURIComponent(sessionID)}/form`,
  )
  const list = Array.isArray(data) ? data : (data.data ?? [])
  return list.filter((form) => form?.id && Array.isArray(form.fields))
}

/** 提表单答案：answer 是 { 字段 key: 值 }，多选传字符串数组。 */
export async function replyForm(
  sessionID: string,
  formID: string,
  answer: Record<string, unknown>,
): Promise<void> {
  await call(
    `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`,
    { method: 'POST', body: JSON.stringify({ answer }) },
  )
}

/** 跳过（取消）表单：模型会收到取消原因。 */
export async function cancelForm(
  sessionID: string,
  formID: string,
  message?: string,
): Promise<void> {
  const query = message ? `?message=${encodeURIComponent(message)}` : ''
  await call(
    `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}${query}`,
    { method: 'DELETE' },
  )
}

/** 当前目录可切换的 agent（只保留用户可选的主 agent）。 */
export async function listAgents(root: string): Promise<AgentInfo[]> {
  const data = await call<{ data?: AgentInfo[] } | AgentInfo[]>(
    `/api/agent?location%5Bdirectory%5D=${encodeURIComponent(root)}`,
  )
  const list = Array.isArray(data) ? data : (data.data ?? [])
  return list.filter((agent) => agent.id && !agent.hidden && agent.mode !== 'subagent')
}

/** 切换当前会话的 agent（对后续请求生效）。 */
export async function switchAgent(sessionID: string, agent: string): Promise<void> {
  await call(`/api/session/${encodeURIComponent(sessionID)}/agent`, {
    method: 'POST',
    body: JSON.stringify({ agent }),
  })
}

/** 当前目录的斜杠命令（服务端配置的命令）。 */
export async function listCommands(root: string): Promise<CommandInfo[]> {
  const data = await call<{ data?: CommandInfo[] } | CommandInfo[]>(
    `/api/command?location%5Bdirectory%5D=${encodeURIComponent(root)}`,
  )
  const list = Array.isArray(data) ? data : (data.data ?? [])
  return list.filter((command) => command.name)
}

/** 执行服务端斜杠命令（/goal、/swarm、/vkb 等）。 */
export async function runSessionCommand(
  sessionID: string,
  name: string,
  text = '',
): Promise<void> {
  await call(`/api/session/${encodeURIComponent(sessionID)}/command`, {
    method: 'POST',
    body: JSON.stringify({ name, text }),
  })
}

/** 压缩当前会话上下文。 */
export async function compactSession(sessionID: string): Promise<void> {
  await call(`/api/session/${encodeURIComponent(sessionID)}/compact`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

/**
 * 暂存一次回撤：把 messageID 这条消息（含它之后的所有消息）标成「待回滚」。
 *
 * 只标记、不删除——服务端保留原消息，可以 clear 取消，适合做「回撤预览」。
 * 返回内容里的 messageID / files 说明边界落在哪、动到了哪些文件。
 *
 * files 传 true 时连这条消息之后产生的文件改动一起还原（快照回滚）；
 * 不传或 false 只回撤消息，不动磁盘上的文件。
 */
export async function stageRevert(
  sessionID: string,
  messageID: string,
  files?: boolean,
): Promise<SessionRevert> {
  const body: { messageID: string; files?: boolean } = { messageID }
  if (files !== undefined) body.files = files
  const data = await call<{ data?: SessionRevert }>(
    `/api/session/${encodeURIComponent(sessionID)}/revert/stage`,
    { method: 'POST', body: JSON.stringify(body) },
  )
  const revert = data?.data
  if (!revert?.messageID) throw new Error('回撤失败：响应里没有边界消息')
  return revert
}

/** 提交暂存的回撤：真正删掉边界消息及其之后的内容。不可恢复。 */
export async function commitRevert(sessionID: string): Promise<void> {
  await call(`/api/session/${encodeURIComponent(sessionID)}/revert/commit`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

/** 取消暂存的回撤：消息恢复显示，什么都没删。 */
export async function clearRevert(sessionID: string): Promise<void> {
  await call(`/api/session/${encodeURIComponent(sessionID)}/revert`, { method: 'DELETE' })
}

/** 发一条用户消息；返回后内容会通过 SSE 陆续推过来。files 是图片/文件附件。 */
export async function sendPrompt(
  sessionID: string,
  text: string,
  files: PromptFile[] = [],
): Promise<void> {
  const body: { text: string; files?: PromptFile[] } = { text }
  if (files.length > 0) body.files = files
  await call(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** 当前目录可用的模型列表（只保留有 id + providerID 的）。 */
export async function listModels(root: string): Promise<ModelInfo[]> {
  const data = await call<{ data?: ModelInfo[] } | ModelInfo[]>(
    `/api/model?location%5Bdirectory%5D=${encodeURIComponent(root)}`,
  )
  const list = Array.isArray(data) ? data : (data.data ?? [])
  return list.filter((model) => model.id && model.providerID)
}

/** 默认模型：会话自己没记 model 时用它兜底显示。 */
export async function getDefaultModel(root: string): Promise<ModelInfo | null> {
  try {
    const data = await call<{ data?: ModelInfo }>(
      `/api/model/default?location%5Bdirectory%5D=${encodeURIComponent(root)}`,
    )
    const model = data?.data
    return model?.id && model.providerID ? model : null
  } catch {
    return null
  }
}

/** 切换会话使用的模型。 */
export async function switchModel(sessionID: string, model: ModelRef): Promise<void> {
  await call(`/api/session/${encodeURIComponent(sessionID)}/model`, {
    method: 'POST',
    body: JSON.stringify({ model }),
  })
}

/** 单个会话（用来判断 busy/idle）。 */
export async function getSession(sessionID: string): Promise<SessionInfo> {
  const data = await call<{ data?: SessionInfo }>(
    `/api/session/${encodeURIComponent(sessionID)}`,
  )
  return data.data ?? ({} as SessionInfo)
}

/** 中断正在生成的回复；返回后端是否确实中断了。 */
export async function interruptSession(sessionID: string): Promise<boolean> {
  const data = await call<{ interrupted?: boolean }>(
    `/api/session/${encodeURIComponent(sessionID)}/interrupt`,
    { method: 'POST' },
  )
  return data?.interrupted ?? false
}

/** 会话是否正在生成：busy 时间戳晚于 idle。 */
export function isSessionBusy(session: SessionInfo): boolean {
  const busy = session.time?.busy ?? 0
  const idle = session.time?.idle ?? 0
  return busy > idle
}

/**
 * 会话条目上的「最后一次对话」时间。
 *
 * 服务端每次会话更新（包括消息落库）都会刷 `time.updated`，所以它就是我们能拿到的
 * 最后活跃时间；`busy` / `idle` 只在生成过程中有意义，不能当历史时间用。
 * 返回 0 / 缺字段时返回 undefined，调用方据此决定要不要渲染时间。
 */
export function sessionLastAt(session: SessionInfo): number | undefined {
  const at = session.time?.updated ?? session.time?.created
  return typeof at === 'number' && at > 0 ? at : undefined
}

/** 服务端推来的事件。字段按实际用到的那几个声明，其余不管。 */
export type StreamEvent = {
  type?: string
  data?: {
    sessionID?: string
    assistantMessageID?: string
    /** 同一条消息里第几个 text 段 */
    ordinal?: number
    /** 流式增量 */
    delta?: string
    /** 定稿全文（text.ended 带） */
    text?: string
    /** step.started 带的开始时间 */
    started?: number
    agent?: string
    model?: { id?: string; providerID?: string }
    form?: { sessionID?: string }
  }
}

/**
 * 这类事件本地就能处理（改本地消息），不需要重新拉整包。
 * 其余事件（step.ended、execution.* 等）仍然触发一次全量对账。
 */
const INCREMENTAL_EVENTS = new Set([
  'session.step.started',
  'session.text.started',
  'session.text.delta',
  'session.text.ended',
])

export function isIncrementalEvent(type: string | undefined): boolean {
  return typeof type === 'string' && INCREMENTAL_EVENTS.has(type)
}

/**
 * 订阅 `/api/event`。
 *
 * 不用 EventSource：它不能带自定义请求头，而本地服务要求 `x-oc-token`。
 * 这里用 fetch 流手动按 SSE 的 `data: {...}` 行解析（心跳是 `: heartbeat`，跳过）。
 */
export async function subscribeEvents(
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const headers = new Headers()
  const current = token()
  if (current) headers.set('x-oc-token', current)
  const res = await fetch(withBase('/api/event'), { headers, signal })
  if (!res.ok || !res.body) throw new Error(`事件流连接失败：${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''
    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        try {
          onEvent(JSON.parse(payload))
        } catch {
          // 单条坏数据不影响后续流
        }
      }
    }
  }
}
