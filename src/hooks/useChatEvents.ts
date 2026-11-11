import { useEffect, useRef } from 'react'
import { subscribeEvents } from '../api/chat'

/**
 * 事件合并窗口：SSE 事件很密（流式输出时每几十毫秒一条），
 * 合并成一次刷新，避免一条事件拉一次全量消息。
 */
const REFRESH_DELAY_MS = 80

/**
 * 订阅 `/api/event`，只把「当前会话」的事件合并成一次刷新回调。
 *
 * 刷新是**串行**的：同一时刻只有一个请求在飞。拉取期间来的事件只记一笔 pending，
 * 回来立刻补拉一次。之前没有这道闸，拉取慢的时候（大会话全量拉要几百毫秒）
 * 事件按 250ms 叠着发请求，互相拖慢，表现为「越聊越卡、几秒才显示」。
 *
 * 断线后 2 秒重连，组件卸载/切换时取消。
 */
export function useChatEvents(
  connected: boolean,
  currentID: string | null,
  onRefresh: (sessionID: string) => void | Promise<void>,
): void {
  const currentRef = useRef(currentID)
  currentRef.current = currentID
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  useEffect(() => {
    if (!connected) return
    const controller = new AbortController()
    let stopped = false

    let timer: number | null = null
    let running = false
    let pending: string | null = null

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
    }

    const flush = async () => {
      clearTimer()
      if (stopped || running) return
      const sessionID = pending
      if (!sessionID) return
      pending = null

      running = true
      try {
        await onRefreshRef.current(sessionID)
      } catch {
        // 单次刷新失败不影响后续事件
      } finally {
        running = false
        // 拉取期间又来了事件：立刻补一次，不再等合并窗口
        if (!stopped && pending) void flush()
      }
    }

    const schedule = (sessionID: string) => {
      pending = sessionID
      if (running || timer !== null) return
      timer = window.setTimeout(() => void flush(), REFRESH_DELAY_MS)
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
      clearTimer()
    }
  }, [connected])
}
