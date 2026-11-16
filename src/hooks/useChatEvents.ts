import { useEffect, useRef } from 'react'
import { BALANCE_REFRESH_EVENT } from '../api/balance'
import { isIncrementalEvent, subscribeEvents, type StreamEvent } from '../api/chat'
import { retryDelay } from '../components/retryPolicy'

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

    let reconnected = false
    /**
     * 连续断线次数：只用来决定下一次重连等多久（退避），
     * 连上就不再累加。上限回绕是为了别让数字无限涨（它只影响延迟档位）。
     */
    let reconnectCount = 0
    // 重连补的全量也要走同一道串行闸，并且限频：
    // 连接秒断秒连时不能每 2 秒抓一次完整消息窗。
    let lastOpenRefresh = 0
    ;(async () => {
      while (!stopped) {
        try {
          await subscribeEvents((event) => {
            // 一轮模型调用结束 = 刚刚扣了钱：广播一次，让顶栏余额立刻更新。
            // 任何会话都算（余额是账号级的），胶囊自己做了 2.5 秒节流。
            if (typeof event.type === 'string' && event.type.endsWith('step.ended')) {
              window.dispatchEvent(new CustomEvent(BALANCE_REFRESH_EVENT))
            }

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
            },
            controller.signal,
            () => {
              // 刚连上：退避计数清零，下一次断线重新从 0.8 秒开始。
              reconnectCount = 0
              // 除了第一次，说明之前断过：断线期间的流式增量已经丢了。
              // 补数据复用 schedule 的串行闸 + 80ms 合并，并且 3 秒内不重复。
              if (!reconnected) return
              const sid = currentRef.current
              if (!sid) return
              const now = Date.now()
              if (now - lastOpenRefresh < 3000) return
              lastOpenRefresh = now
              schedule(sid)
            },
          )
        } catch {
          // 连不上：下面统一退避，不在这里刷新
        }
        if (stopped) return
        reconnected = true
        // 正常 EOF 也要退避：后端发完头就断时不能紧贴着重连。
        //
        // 节奏交给 retryPolicy：连续断线时从 0.8 秒退到 8 秒封顶。
        // 原来固定 2 秒，服务重启期间会一直以固定频率敲门；
        // 而第一次断线时 2 秒又偏慢，用户能看到一段明显的事件真空。
        await new Promise((resolve) => window.setTimeout(resolve, retryDelay(reconnectCount)))
        reconnectCount += 1
        if (reconnectCount > 20) reconnectCount = 0
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
