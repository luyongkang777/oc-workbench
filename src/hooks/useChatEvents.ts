import { useEffect, useRef } from 'react'
import { subscribeEvents } from '../api/chat'

/** 事件流合并窗口：SSE 事件很多，250ms 合并成一次刷新。 */
const REFRESH_DELAY_MS = 250

/**
 * 订阅 `/api/event`，只把「当前会话」的事件合并成 250ms 一次的刷新回调。
 * 断线后 2 秒重连，组件卸载/切换时取消。
 */
export function useChatEvents(
  connected: boolean,
  currentID: string | null,
  onRefresh: (sessionID: string) => void,
): void {
  const currentRef = useRef(currentID)
  currentRef.current = currentID
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!connected) return
    const controller = new AbortController()
    let stopped = false

    const schedule = (sessionID: string) => {
      if (timerRef.current !== null) return
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        onRefreshRef.current(sessionID)
      }, REFRESH_DELAY_MS)
    }

    ;(async () => {
      while (!stopped) {
        try {
          await subscribeEvents((event) => {
            // form.created 的 data 是 { form: {...} }，sessionID 在 form 里
            const sid = event.data?.sessionID ?? event.data?.form?.sessionID
            if (!sid || currentRef.current !== sid) return
            schedule(sid)
          }, controller.signal)
        } catch {
          if (stopped) return
          await new Promise((resolve) => window.setTimeout(resolve, 2000))
        }
      }
    })()

    return () => {
      stopped = true
      controller.abort()
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [connected])
}
