import { useEffect, useState } from 'react'

import { fetchMcpServers } from '../api/mcp'
import type { McpServerInfo } from '../components/mcpStatus'

/**
 * pending 状态的重拉间隔。
 *
 * 服务端连远程 MCP 是启动时并行的，第一次打开界面往往还在连；
 * 光拉一次会永远停在「连接中」，所以要跟几次，直到没有 pending。
 */
const PENDING_RETRY_MS = 8000

/** 最多跟 6 轮（约 48 秒）：真连不上的会变 failed，不该无限轮询。 */
const MAX_PENDING_RETRIES = 6

export type McpServersState = {
  servers: McpServerInfo[]
  loading: boolean
  error: string | null
  /** 手动重新检测（面板上的按钮） */
  refresh: () => void
}

/**
 * 当前目录的 MCP 服务器状态。
 *
 * 不在后台常驻轮询：状态变化很少，展开面板时点「重新检测」就够了；
 * 只在还有 pending 时短时间追几轮，避免读数卡在「连接中」骗人。
 */
export function useMcpServers(root: string | undefined, connected: boolean): McpServersState {
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!connected) {
      // 断开时清空：留着旧状态会让人以为还是实时的
      setServers((prev) => (prev.length === 0 ? prev : []))
      setError(null)
      setLoading(false)
      return
    }

    let alive = true
    let timer = 0
    let retries = 0

    async function load(first: boolean) {
      if (first) setLoading(true)
      try {
        const list = await fetchMcpServers(root)
        if (!alive) return
        setServers(list)
        setError(null)
        if (list.some((server) => server.status === 'pending') && retries < MAX_PENDING_RETRIES) {
          retries += 1
          timer = window.setTimeout(() => void load(false), PENDING_RETRY_MS)
        }
      } catch (err) {
        if (!alive) return
        // 失败保留上一次的列表：一次抖动不该把整块读数清空
        setError(err instanceof Error ? err.message : 'MCP 状态读取失败')
      } finally {
        if (alive) setLoading(false)
      }
    }

    void load(true)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [root, connected, tick])

  return {
    servers,
    loading,
    error,
    refresh: () => setTick((value) => value + 1),
  }
}
