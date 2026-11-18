import { useEffect, useRef, useState } from 'react'
import { isRemoteHost } from '../api/auth'
import { getSession } from '../api/chat'
import { onPageVisible, pageVisible } from '../api/visibility'
import {
  LOCAL_INTERVALS,
  NO_STOP_GUARD,
  REMOTE_INTERVALS,
  STOP_GRACE_MS,
  nextRunningID,
  pollDelay,
  respectStopGrace,
  type StopGuard,
} from '../components/runningPoll'

/** 连续失败多少次后把间隔拉到最慢一档（服务真的断了就别死打）。 */
const MAX_FAILURES = 5

/**
 * 「某个会话正在生成」的状态。
 *
 * 用 runningID 而不是布尔值：切走再切回同一个会话，还能认出它仍在生成；
 * 切到别的会话时按那个会话自己的 busy 状态初始化，不会把 A 的按钮带到 B。
 *
 * 判定以**服务端会话状态为准**，并且空闲时也慢速轮询：
 * 以前只在「自认为在跑」时轮询，一次误判（busy 时间戳晚到、或连续失败）就
 * 永久停住，界面看着像没在跑，只有切走再切回才会自愈 —— 这正是用户报的问题。
 */
export function useChatRunning(connected: boolean, currentID: string | null) {
  const [runningID, setRunningID] = useState<string | null>(null)
  /** 定时器闭包里要读最新值，又不能把它写进依赖（那样每次状态变化都会重建轮询） */
  const runningRef = useRef<string | null>(null)
  runningRef.current = runningID
  /**
   * 用户手动停止后留下的抑制窗口。
   *
   * 中断返回成功时本地已经清掉「在跑」，但服务端可能还没把 busy 翻成 idle，
   * 这段窗口里照实读会让按钮闪回「停止」。窗口只对「停止那条会话 + 停止时那一轮」
   * 生效，换会话或起了新一轮都自动放行（见 `respectStopGrace`）。
   */
  const stopGuardRef = useRef<StopGuard>(NO_STOP_GUARD)
  /** 最近一次读到的服务端 busy 时间戳：停止时拿它当「旧一轮」的基准 */
  const lastBusyRef = useRef(0)

  const intervals = isRemoteHost() ? REMOTE_INTERVALS : LOCAL_INTERVALS

  // 切会话：先按该会话的 busy 状态初始化（接上已经开始/正在生成的回复）
  useEffect(() => {
    if (!connected || !currentID) {
      setRunningID(null)
      return
    }
    let alive = true
    ;(async () => {
      try {
        const session = await getSession(currentID)
        if (!alive) return
        const busy = nextRunningID(currentID, session) !== null
        const busyAt = session?.time?.busy ?? 0
        lastBusyRef.current = busyAt
        setRunningID(
          respectStopGrace(busy, Date.now(), stopGuardRef.current, currentID, busyAt)
            ? currentID
            : null,
        )
      } catch {
        // 查不到 = 「不知道」，保持现状交给轮询纠错。
        // 这里绝不能当成空闲：一次抖动就会把「停止」按钮换成「发送」。
      }
    })()
    return () => {
      alive = false
    }
  }, [connected, currentID])

  // 持续轮询当前会话：生成中快查，空闲慢查（自愈靠这条）
  useEffect(() => {
    if (!connected || !currentID) return
    let alive = true
    let failures = 0
    let timer = 0

    const schedule = (running: boolean) => {
      if (!alive) return
      window.clearTimeout(timer)
      // 连续失败时退到最慢一档：服务断开期间不该继续高频敲门
      const delay =
        failures >= MAX_FAILURES
          ? pollDelay(intervals, false) * 2
          : pollDelay(intervals, running)
      timer = window.setTimeout(() => void tick(), delay)
    }

    async function tick() {
      // 窗口不可见时不查：没人看按钮，省掉请求（恢复可见时下面会立刻补一次）
      if (!pageVisible()) {
        schedule(runningRef.current !== null)
        return
      }
      try {
        const session = await getSession(currentID!)
        if (!alive) return
        failures = 0
        const busy = nextRunningID(currentID!, session) !== null
        const busyAt = session?.time?.busy ?? 0
        lastBusyRef.current = busyAt
        const effective = respectStopGrace(
          busy,
          Date.now(),
          stopGuardRef.current,
          currentID!,
          busyAt,
        )
        setRunningID(effective ? currentID : null)
        schedule(effective)
      } catch {
        // 失败**不清** running：多数是网络抖动，清掉会让「停止」消失、
        // 还可能让用户又发一条。按最慢档继续试，恢复后自动对齐。
        failures += 1
        schedule(runningRef.current !== null)
      }
    }

    void tick()

    // 从后台切回来立刻补一次：隐藏期间没轮询，别让状态多等一个周期
    const offVisible = onPageVisible(() => {
      window.clearTimeout(timer)
      void tick()
    })

    return () => {
      alive = false
      window.clearTimeout(timer)
      offVisible()
    }
  }, [connected, currentID])

  const running = runningID !== null && runningID === currentID
  return {
    running,
    start: (id: string | null) => {
      // 新一轮已经发出去了：清掉窗口让它照实读，不然刚起来的生成会被判成空闲。
      // start(null) 等同「主动清空」，行为一样。
      stopGuardRef.current = NO_STOP_GUARD
      setRunningID(id)
    },
    /**
     * 停止（用户点了「停止」，或后端确认中断）。
     *
     * 顺手开一个短暂抑制窗口：服务端翻 busy→idle 有延迟，不抑制按钮会闪一次。
     */
    stop: () => {
      stopGuardRef.current = {
        until: Date.now() + STOP_GRACE_MS,
        busyAt: lastBusyRef.current,
        sessionID: currentID ?? '',
      }
      setRunningID(null)
    },
  }
}
