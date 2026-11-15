import { useEffect, useRef } from 'react'
import { isIncrementalEvent, subscribeEvents, type StreamEvent } from '../api/chat'

/**
 * 事件合并窗口：只有「需要全量对账」的事件才走这里。
 * 流式文本（text.delta / text.ended 等）由 onEvent 直接改本地消息，不重拉。
 */
const REFRESH_DELAY_MS = 80

/**
 * 「别的会话有动静」的合并窗口。
 *
 * 手机上（或 CLI 里）在另一个会话里发消息时，本窗口必须知道「列表里多/变了一个会话」，
 * 否则会一直显示旧列表。这类事件只触发一次列表刷新，不做增量补丁，可以合并得粗一点。
 */
const OTHER_ACTIVITY_DELAY_MS = 600

/**
 * 订阅 `/api/event`。
 *
 * - 增量事件（step.started / text.*）交给 onEvent 本地打补丁，不发请求
 * - 当前会话的其它事件合并成一次全量刷新，且**串行**：同一时刻只有一个请求在飞，
 *   期间来的事件只记一笔，回来立刻补一次（原来没有这道闸，大会话里几个
 *   全量请求互相拖慢，表现就是越聊越卡）
 * - **别的会话**（手机端 / CLI）的结构性事件交给 `onOtherActivity`，
 *   让会话列表自己刷新 —— 以前这里直接 `return` 丢掉，导致「手机聊了，
 *   电脑上的列表一直不变」
 *
 * 断线后 2 秒重连，组件卸载/切换时取消。
 */
export function useChatEvents(
  connected: boolean,
  currentID: string | null,
  onRefresh: (sessionID: string) => void | Promise<void>,
  onEvent?: (event: StreamEvent) => void,
  onOtherActivity?: () => void,
): void {
  const currentRef = useRef(currentID)
  currentRef.current = currentID
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const onOtherRef = useRef(onOtherActivity)
  onOtherRef.current = onOtherActivity

  useEffect(() => {
    if (!connected) return
    const controller = new AbortController()
    let stopped = false

    let timer: number | null = null
    let running = false
    let pending: string | null = null

    let otherTimer: number | null = null

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
        if (!stopped && pending) void flush()
      }
    }

    const schedule = (sessionID: string) => {
      pending = sessionID
      if (running || timer !== null) return
      timer = window.setTimeout(() => void flush(), REFRESH_DELAY_MS)
    }

    const scheduleOther = () => {
      if (otherTimer !== null) return
      otherTimer = window.setTimeout(() => {
        otherTimer = null
        if (stopped) return
        try {
          onOtherRef.current?.()
        } catch {
          // 列表刷新失败不该影响事件循环
        }
      }, OTHER_ACTIVITY_DELAY_MS)
    }

    ;(async () => {
      while (!stopped) {
        try {
          await subscribeEvents((event) => {
            // form.created 的 data 是 { form: {...} }，sessionID 在 form 里
            const sid = event.data?.sessionID ?? event.data?.form?.sessionID

            // 没有 sessionID 的结构性事件（session.created / updated 这类）：
            // 无法判断是不是当前会话，保守起见也刷新一次列表。
            if (!sid) {
              if (!isIncrementalEvent(event.type)) scheduleOther()
              return
            }

            // 别的会话有动静：只重置列表，不做增量补丁（那些 delta 属于另一条会话）
            if (currentRef.current !== sid) {
              if (!isIncrementalEvent(event.type)) scheduleOther()
              return
            }

            // 先给上层一次本地打补丁的机会
            try {
              onEventRef.current?.(event)
            } catch {
              // 补丁出错不能让事件循环断掉
            }

            // 增量事件到此为止，不触发全量拉取
            if (isIncrementalEvent(event.type)) return
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
      if (otherTimer !== null) window.clearTimeout(otherTimer)
    }
  }, [connected])
}
