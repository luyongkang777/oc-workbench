import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getDefaultModel,
  listModels,
  switchModel,
  type ModelInfo,
  type ModelRef,
  type SessionInfo,
} from '../api/chat'

/** 静默刷新间隔：网关侧随时会加减模型，轮询比「连接时拉一次」更贴近实时 */
const REFRESH_MS = 60_000

/**
 * 模型列表 + 当前会话模型。
 *
 * 显示规则：会话自己记了 model 就用它；没记（新建后还没聊过）用默认模型；
 * 都没有就显示「选择模型」。切换时先请求成功后改界面，失败由调用方提示。
 */
export function useChatModels(root: string, connected: boolean) {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [defaultModel, setDefaultModel] = useState<ModelRef | null>(null)
  const [model, setModel] = useState<ModelRef | null>(null)
  // 静默刷新同时只允许一个请求在飞
  const refreshingRef = useRef(false)

  const fetchModels = useCallback(async () => {
    const list = await listModels(root)
    setModels(list)
    return list
  }, [root])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await fetchModels()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [fetchModels])

  /**
   * 静默刷新：不显示 loading、不动当前选择，失败保留上一份列表。
   * 用于打开下拉、窗口回焦、定时轮询——模型是网关侧随时会变的，
   * 只在连接时拉一次会一直看到旧列表。
   */
  const refresh = useCallback(async () => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    try {
      await fetchModels()
      setError(null)
    } catch {
      // 网关暂时不通：保留旧列表，不把下拉变成错误态
    } finally {
      refreshingRef.current = false
    }
  }, [fetchModels])

  // 连上后拉列表 + 默认模型
  useEffect(() => {
    if (!connected) return
    let alive = true
    void load()
    ;(async () => {
      const fallback = await getDefaultModel(root)
      if (!alive || !fallback?.id || !fallback.providerID) return
      setDefaultModel({ id: fallback.id, providerID: fallback.providerID })
    })()
    return () => {
      alive = false
    }
  }, [connected, load, root])

  // 连接存续期间保持列表新鲜：窗口回焦、页面重新可见、以及定时轮询
  useEffect(() => {
    if (!connected) return
    const onFocus = () => void refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, REFRESH_MS)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(timer)
    }
  }, [connected, refresh])

  /** 会话切换/会话数据变化时同步显示：会话自己的 model > 默认模型 > 空。 */
  const syncSession = useCallback(
    (session: SessionInfo | undefined) => {
      const own = session?.model
      if (own?.id && own.providerID) {
        setModel({ id: own.id, providerID: own.providerID, variant: own.variant })
        return
      }
      setModel(defaultModel ? { ...defaultModel } : null)
    },
    [defaultModel],
  )

  /**
   * 选模型：同 id+provider 时保留会话原有 variant（避免推理档位被静默改成 default）。
   * 先请求成功再改界面，失败抛给调用方。
   */
  const pick = useCallback(
    async (next: ModelInfo, sessionID: string | null, keepVariant?: string) => {
      const key: ModelRef = { id: next.id, providerID: next.providerID }
      if (sessionID) {
        await switchModel(sessionID, keepVariant ? { ...key, variant: keepVariant } : key)
      }
      setModel(keepVariant ? { ...key, variant: keepVariant } : key)
      return keepVariant ? { ...key, variant: keepVariant } : key
    },
    [],
  )

  /**
   * 选思考强度：variant 为空 = 用该模型默认档位。
   * 先请求成功再改界面，失败抛给调用方。
   */
  const pickVariant = useCallback(
    async (next: ModelInfo, sessionID: string | null, variant?: string) => {
      const key: ModelRef = variant
        ? { id: next.id, providerID: next.providerID, variant }
        : { id: next.id, providerID: next.providerID }
      if (sessionID) await switchModel(sessionID, key)
      setModel(key)
      return key
    },
    [],
  )

  return { models, loading, error, reload: load, refresh, model, syncSession, pick, pickVariant }
}
