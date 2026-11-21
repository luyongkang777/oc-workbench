import { authToken, withBase } from './base.ts'
/**
 * MCP 服务器列表与运行时操作。
 *
 * 列表：`GET /api/mcp?location[directory]=<root>`，返回「当前目录下配置的所有
 * MCP 服务器 + 连接状态」。原始结构里还有 integrationID 等字段，这里只挑界面要用的，
 * 清洗在 mcpStatus.ts。
 *
 * 运行时开关（opencode 的实验性接口，已实测）：
 *   `POST /api/experimental/mcp/<name>/connect`    → 运行时连接（覆盖配置里的 disabled 直到重启）
 *   `POST /api/experimental/mcp/<name>/disconnect` → 运行时断开，工具立即从会话里消失
 * 两条都不写配置文件，重启后恢复成配置里的状态。
 */
import { normalizeMcpServers, type McpServerInfo } from '../components/mcpStatus'

/** 后端返回的一条记录；status 可能带 error。 */
export type McpServerRecord = {
  name: string
  title?: string
  status?: { status?: string; error?: string }
}

/** 单次请求上限：服务端若卡在探测远端 MCP，界面不能永远停在「检测中」。 */
const REQUEST_TIMEOUT_MS = 8000

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  // dev 模式走 Vite 代理（cookie 由代理注入），这时没有 token；
  // 别发空的 x-oc-token，否则会被上游当成带了错误凭据。
  const current = authToken()
  if (current) headers.set('x-oc-token', current)

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(withBase(path), {
      ...init,
      headers,
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  } catch (err) {
    if (timedOut) throw new Error('读取 MCP 状态超时')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 拉当前目录的 MCP 服务器列表。
 *
 * root 为空时不带 location，让服务端用它自己的默认目录——终端等场景没有 root。
 */
export async function listMcpServers(root?: string): Promise<McpServerRecord[]> {
  const query = root ? `?location%5Bdirectory%5D=${encodeURIComponent(root)}` : ''
  const data = await call<{ data?: McpServerRecord[] } | McpServerRecord[]>(
    `/api/mcp${query}`,
  )
  return Array.isArray(data) ? data : (data?.data ?? [])
}

/** 拉一次并清洗成界面结构。 */
export async function fetchMcpServers(root?: string): Promise<McpServerInfo[]> {
  return normalizeMcpServers(await listMcpServers(root))
}

/** location 查询参数：MCP 运行时分目录，操作时必须和列表带同一个目录。 */
function locationQuery(root?: string): string {
  return root ? `?location%5Bdirectory%5D=${encodeURIComponent(root)}` : ''
}

/** 运行时连接一个 MCP 服务器（失败会抛错，错误文案直接给界面）。 */
export async function connectMcpServer(name: string, root?: string): Promise<void> {
  await call(`/api/experimental/mcp/${encodeURIComponent(name)}/connect${locationQuery(root)}`, {
    method: 'POST',
  })
}

/** 运行时断开一个 MCP 服务器：它的工具会立刻从会话里消失，重启后恢复。 */
export async function disconnectMcpServer(name: string, root?: string): Promise<void> {
  await call(`/api/experimental/mcp/${encodeURIComponent(name)}/disconnect${locationQuery(root)}`, {
    method: 'POST',
  })
}
