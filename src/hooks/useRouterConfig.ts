/**
 * 路由配置的加载/保存/删除。
 *
 * 只负责「项目里的 agent 文件」这一层；调不调得动服务端由 opencode 自己发现，
 * 面板据此判断「已启用 / 未启用」。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { listSessions, switchAgent } from '../api/chat'
import { loadRouterFiles, removeRouterFiles, saveRouterFiles } from '../api/agents'
import {
  ROUTER_AGENT_NAMES,
  ROUTER_ROLES,
  buildRouterAgents,
  modelsFromAgents,
  parseRouterAgent,
  routerStatus,
  validateRouterModels,
  type RouterModels,
  type RouterStatus,
} from '../components/routerConfig'

const NAMES = ROUTER_ROLES.map((role) => ROUTER_AGENT_NAMES[role])

const EMPTY_STATUS: RouterStatus = routerStatus([])

export type RouterConfigApi = {
  loading: boolean
  status: RouterStatus
  models: Partial<RouterModels>
  error: string | null
  refresh: () => Promise<void>
  save: (models: RouterModels) => Promise<void>
  remove: () => Promise<void>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 删配置前，先把还在用 router-* 的会话挪回 build。 */
async function releaseSessions(root: string): Promise<void> {
  let sessions: Awaited<ReturnType<typeof listSessions>> = []
  try {
    // 翻三页（150 条）：正常项目够用，又不会为了删配置把所有历史翻一遍
    sessions = await listSessions(150, root, { pages: 3 })
  } catch {
    // 服务端连不上时只管删文件；文件删掉后服务端也会自己移除 agent
    return
  }
  const using = sessions.filter((session) => (session.agent ?? '').startsWith('router-'))
  const running = using.filter(
    (session) => (session.time?.busy ?? 0) > (session.time?.idle ?? 0),
  )
  if (running.length > 0) {
    throw new Error(
      `有 ${running.length} 个会话正在跑路由任务，先停止或把模式切回 Build 再删除`,
    )
  }
  for (const session of using) {
    await switchAgent(session.id, 'build')
  }
}

export function useRouterConfig(root: string): RouterConfigApi {
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<RouterStatus>(EMPTY_STATUS)
  const [models, setModels] = useState<Partial<RouterModels>>({})
  const [error, setError] = useState<string | null>(null)

  // 切项目/连续刷新时，晚到的旧结果不能盖掉新结果
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const gen = ++generation.current
    if (!root) {
      setStatus(EMPTY_STATUS)
      setModels({})
      setError(null)
      return
    }
    setLoading(true)
    try {
      const files = await loadRouterFiles(root, NAMES)
      if (gen !== generation.current) return
      const parsed = files.map((file) => parseRouterAgent(file.name, file.content))
      setStatus(routerStatus(files))
      setModels(modelsFromAgents(parsed))
      setError(null)
    } catch (err) {
      if (gen !== generation.current) return
      setError(messageOf(err))
    } finally {
      if (gen === generation.current) setLoading(false)
    }
  }, [root])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = useCallback(
    async (next: RouterModels) => {
      const errors = validateRouterModels(next)
      if (errors.length > 0) throw new Error(errors.join('；'))
      await saveRouterFiles(root, buildRouterAgents(next))
      await refresh()
    },
    [root, refresh],
  )

  const remove = useCallback(async () => {
    await releaseSessions(root)
    await removeRouterFiles(root, NAMES)
    await refresh()
  }, [root, refresh])

  return { loading, status, models, error, refresh, save, remove }
}
