import { useCallback, useEffect, useRef, useState } from 'react'
import { listForms, type FormInfo } from '../api/chat'

/**
 * 当前会话里等待答复的表单（question 工具）。
 * 由 Chat 在消息/表单事件刷新时一起调用 reload；会话切换时自动拉一次。
 */
export function useChatForms(connected: boolean, sessionID: string | null) {
  const [forms, setForms] = useState<FormInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const currentRef = useRef<string | null>(sessionID)
  currentRef.current = sessionID

  const reload = useCallback(async (sid: string) => {
    try {
      const list = await listForms(sid)
      if (currentRef.current === sid) {
        setForms(list)
        setError(null)
      }
      return list
    } catch (err) {
      if (currentRef.current === sid) setError((err as Error).message)
      return []
    }
  }, [])

  useEffect(() => {
    if (!connected || !sessionID) {
      setForms([])
      return
    }
    void reload(sessionID)
  }, [connected, sessionID, reload])

  return { forms, error, reload }
}
