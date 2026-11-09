import { useEffect, useState } from 'react'
import { getSession, isSessionBusy } from '../api/chat'

/** 连续查询失败多少次后放弃跟踪（网络断开/令牌过期时别一直打）。 */
const MAX_FAILURES = 5
const POLL_MS = 800

/**
 * 「某个会话正在生成」的状态。
 *
 * 用 runningID 而不是布尔值：切走再切回同一个会话，还能认出它仍在生成；
 * 切到别的会话时按那个会话自己的 busy 状态初始化，不会把 A 的按钮带到 B。
 */
export function useChatRunning(connected: boolean, currentID: string | null) {
  const [runningID, setRunningID] = useState<string | null>(null)

  // 切会话：按该会话的 busy 状态初始化（接上已经开始/正在生成的回复）
  useEffect(() => {
    if (!connected || !currentID) {
      setRunningID(null)
      return
    }
    let alive = true
    ;(async () => {
      try {
        const session = await getSession(currentID)
        if (alive) setRunningID(isSessionBusy(session) ? currentID : null)
      } catch {
        if (alive) setRunningID(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [connected, currentID])

  // 生成中轮询：只查正在生成的那个会话
  useEffect(() => {
    if (!connected || !runningID) return
    let alive = true
    let failures = 0
    const timer = window.setInterval(async () => {
      try {
        const session = await getSession(runningID)
        if (!alive) return
        failures = 0
        if (!isSessionBusy(session)) setRunningID(null)
      } catch {
        failures += 1
        if (alive && failures >= MAX_FAILURES) setRunningID(null)
      }
    }, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [connected, runningID])

  const running = runningID !== null && runningID === currentID
  return { running, start: setRunningID, stop: () => setRunningID(null) }
}
