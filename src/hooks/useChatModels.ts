import { useCallback, useEffect, useState } from 'react'
import {
  getDefaultModel,
  listModels,
  switchModel,
  type ModelInfo,
  type ModelRef,
  type SessionInfo,
} from '../api/chat'

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

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await listModels(root)
      setModels(list)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [root])

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

  return { models, loading, error, reload: load, model, syncSession, pick }
}
