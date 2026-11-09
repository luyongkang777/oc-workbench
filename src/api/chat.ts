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

export function isWorkbenchSession(session: SessionInfo): boolean {
  return session.metadata?.source === WORKBENCH_SOURCE
}

export type MessagePart = {
  type: string
  text?: string
  tool?: string
  name?: string
  state?: { status?: string }
}

export type ChatMessage = {
  id: string
  type: string
  text?: string
  content?: MessagePart[]
  time?: { created?: number; completed?: number }
  model?: { id?: string; providerID?: string }
}

/** 切模型/建会话时传的模型引用。variant 是推理档位（high/max…），不传后端会给 default。 */
export type ModelRef = { id: string; providerID: string; variant?: string }

/** 可选模型（GET /api/model）。id + providerID 是切模型时要传的键。 */
export type ModelInfo = {
  id: string
  modelID?: string
  providerID: string
  name?: string
  variants?: { id: string }[]
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

/** 发一条用户消息；返回后内容会通过 SSE 陆续推过来。 */
export async function sendPrompt(sessionID: string, text: string): Promise<void> {
  await call(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
    method: 'POST',
    body: JSON.stringify({ text }),
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
 * 订阅 `/api/event`。
 *
 * 不用 EventSource：它不能带自定义请求头，而本地服务要求 `x-oc-token`。
 * 这里用 fetch 流手动按 SSE 的 `data: {...}` 行解析（心跳是 `: heartbeat`，跳过）。
 */
export async function subscribeEvents(
  onEvent: (event: { type?: string; data?: { sessionID?: string } }) => void,
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
