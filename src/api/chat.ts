/** 会话与事件流（T5）。认证 token 从 window.__OC_TOKEN 读，和 client.ts 一致。 */

export type SessionInfo = {
  id: string
  title?: string
  time?: { created?: number; updated?: number; busy?: number; idle?: number }
  location?: { directory?: string }
  model?: { id?: string; providerID?: string; variant?: string }
  metadata?: Record<string, unknown>
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
  state?: { status?: string }
  /** reasoning 段用它判断是否还在思考：有 created 没 completed = 进行中 */
  time?: { created?: number; completed?: number }
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

export type ChatMessage = {
  id: string
  type: string
  text?: string
  content?: MessagePart[]
  files?: MessageFile[]
  time?: { created?: number; completed?: number }
  model?: { id?: string; providerID?: string }
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
  const res = await fetch(path, { ...init, headers })
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

export async function createSession(
  root: string,
  title?: string,
  model?: ModelRef,
): Promise<SessionInfo> {
  const data = await call<{ data?: SessionInfo }>('/api/session', {
    method: 'POST',
    // metadata 原样存到服务端并在列表接口返回，用它区分「工作台会话」和外部会话
    body: JSON.stringify({
      title,
      model,
      location: { directory: root },
      metadata: { source: WORKBENCH_SOURCE },
    }),
  })
  const session = data.data
  if (!session?.id) throw new Error('创建会话失败：响应里没有 id')
  return session
}

export async function listMessages(sessionID: string): Promise<ChatMessage[]> {
  const data = await call<{ data?: ChatMessage[] }>(
    `/api/session/${encodeURIComponent(sessionID)}/message`,
  )
  return data.data ?? []
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
  const res = await fetch('/api/event', { headers, signal })
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
