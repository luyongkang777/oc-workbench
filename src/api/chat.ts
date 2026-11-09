/** 会话与事件流（T5）。认证 token 从 window.__OC_TOKEN 读，和 client.ts 一致。 */

export type SessionInfo = {
  id: string
  title?: string
  time?: { created?: number; updated?: number }
  location?: { directory?: string }
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

/** 会话列表（只取顶层会话，不含 subagent 子会话）；给了 root 就只留该目录的。 */
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

export async function createSession(root: string, title?: string): Promise<SessionInfo> {
  const data = await call<{ data?: SessionInfo }>('/api/session', {
    method: 'POST',
    body: JSON.stringify({ title, location: { directory: root } }),
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
