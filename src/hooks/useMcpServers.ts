import { useCallback, useEffect, useRef, useState } from 'react'

import { connectMcpServer, disconnectMcpServer, fetchMcpServers } from '../api/mcp'
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
  /** 正在操作的服务器名；'*' 表示「全部重连」在进行；null 表示空闲 */
  busy: string | null
  /** 手动重新检测（面板上的按钮） */
  refresh: () => void
  /** 运行时连接（对 failed / disabled 都是重试一次真连接） */
  connect: (name: string) => void
  /** 运行时断开：工具立刻从会话里消失，重启后恢复 */
  disconnect: (name: string) => void
  /** 把所有失败/要授权的服务器重连一遍 */
  reconnectBroken: () => void
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
  const [busy, setBusy] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  /** 操作后的「补一次刷新」定时器：组件卸载时要清掉，别在卸载后写状态 */
  const extraTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(extraTimer.current), [])

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

  /**
   * 执行一次运行时开关。
   *
   * 接口回 204 只代表「已受理」：断开/连接是异步的，紧接着拉列表还会读到旧状态。
   * 所以等一小会儿再让 effect 重新拉（tick），pending 状态由 effect 自己追几轮。
   */
  const act = useCallback(async (name: string, method: 'connect' | 'disconnect') => {
    setBusy(name)
    setError(null)
    try {
      if (method === 'connect') await connectMcpServer(name, root)
      else await disconnectMcpServer(name, root)
      await new Promise((resolve) => window.setTimeout(resolve, 700))
      setTick((value) => value + 1)
      // 服务端断开/连接是异步的，可能一两秒后才落到 /api/mcp 里；
      // 再补一次刷新，别让界面停在旧状态上。
      window.clearTimeout(extraTimer.current)
      extraTimer.current = window.setTimeout(() => setTick((value) => value + 1), 2200)
    } catch (err) {
      setError(
        `${name} ${method === 'connect' ? '连接' : '断开'}失败：${
          err instanceof Error ? err.message : '未知错误'
        }`,
      )
    } finally {
      setBusy(null)
    }
  }, [root])

  const reconnectBroken = useCallback(() => {
    const broken = servers.filter(
      (server) => server.status === 'failed' || server.status === 'needs_auth',
    )
    if (broken.length === 0) return
    setBusy('*')
    setError(null)
    void (async () => {
      try {
        // 逐个连：服务端本来就要一个个起，并发只会让状态更难读
        for (const server of broken) {
          await connectMcpServer(server.name, root).catch(() => undefined)
        }
      } finally {
        await new Promise((resolve) => window.setTimeout(resolve, 700))
        setTick((value) => value + 1)
        window.clearTimeout(extraTimer.current)
        extraTimer.current = window.setTimeout(() => setTick((value) => value + 1), 2200)
        setBusy(null)
      }
    })()
  }, [servers, root])

  return {
    servers,
    loading,
    error,
    busy,
    refresh: () => setTick((value) => value + 1),
    connect: (name) => void act(name, 'connect'),
    disconnect: (name) => void act(name, 'disconnect'),
    reconnectBroken,
  }
}
