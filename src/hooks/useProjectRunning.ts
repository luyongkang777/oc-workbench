import { useEffect, useState } from 'react'

import { listSessions } from '../api/chat'
import { runningDirectories, sameSet } from '../components/projectStatus.ts'

/**
 * 轮询间隔。
 *
 * 只查一个接口（不带 root 的会话列表），所以项目再多也不会变成 N 个请求；
 * 1.5 秒是「点发送后灯会很快变黄」和「别把本地服务打满」之间的折中。
 */
const POLL_MS = 1500

/**
 * 每个项目是否正在生成，返回规范化路径集合。
 *
 * 和聊天区的 useChatRunning 是两套东西：那个只跟当前会话、用来切发送/停止按钮；
 * 这个跨所有项目、只喂给顶栏的呼吸灯，所以切走标签也不会丢状态。
 */
export function useProjectRunning(connected: boolean, projectCount: number) {
  const [running, setRunning] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!connected || projectCount === 0) {
      setRunning((prev) => (prev.size === 0 ? prev : new Set()))
      return
    }

    let alive = true
    let timer = 0

    const schedule = () => {
      if (alive) timer = window.setTimeout(tick, POLL_MS)
    }

    async function tick() {
      // 窗口在后台/最小化时不查：没人看灯，省掉无意义的请求
      if (document.hidden) {
        schedule()
        return
      }
      try {
        const sessions = await listSessions(60)
        if (!alive) return
        const next = runningDirectories(sessions)
        setRunning((prev) => (sameSet(prev, next) ? prev : next))
      } catch {
        // 单次失败沿用上一次结果，等下一轮；连续失败也不影响界面可用
      }
      schedule()
    }

    void tick()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [connected, projectCount])

  return running
}
