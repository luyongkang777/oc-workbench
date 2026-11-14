/**
 * MCP 服务器列表（`GET /api/mcp`）。
 *
 * 返回的是「当前目录下配置的所有 MCP 服务器 + 连接状态」，不是某条会话专属——
 * 每条会话都在某个目录里跑，所以这就是当前对话能用的那一批。
 * 原始结构里还有 integrationID 等字段，这里只挑界面要用的，清洗在 mcpStatus.ts。
 */
import { normalizeMcpServers, type McpServerInfo } from '../components/mcpStatus'

/** 后端返回的一条记录；status 可能带 error。 */
export type McpServerRecord = {
  name: string
  title?: string
  status?: { status?: string; error?: string }
}

function token(): string {
  return (window as unknown as { __OC_TOKEN?: string }).__OC_TOKEN ?? ''
}

/** 单次请求上限：服务端若卡在探测远端 MCP，界面不能永远停在「检测中」。 */
const REQUEST_TIMEOUT_MS = 8000

async function call<T>(path: string): Promise<T> {
  const headers = new Headers()
  // dev 模式走 Vite 代理（cookie 由代理注入），这时没有 token；
  // 别发空的 x-oc-token，否则会被上游当成带了错误凭据。
  const current = token()
  if (current) headers.set('x-oc-token', current)

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(path, { headers, cache: 'no-store', signal: controller.signal })
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
