import { useEffect, useState } from 'react'

import { listSessions, type SessionInfo } from '../api/chat'
import { runningDirectories, sameSet, type SessionLike } from '../components/projectStatus.ts'

/**
 * 轮询间隔。
 *
 * 只查一个接口（全局最新 60 条会话），所以项目/会话再多也不会变成 N 个请求；
 * 1.5 秒是「点发送后灯会很快变黄」和「别把本地服务打满」之间的折中。
 */
const POLL_MS = 1500

/** 与 projectStatus 的 SessionLike 对齐，多带标题和 id（标签栏要用）。 */
export type LiveSession = SessionLike & { id?: string; title?: string }

export type SessionLights = {
  /** 正在生成的目录（normKey 集合），喂给顶栏项目标签 */
  dirs: Set<string>
  /** 会话 id → 最新 title/time/metadata，喂给状态灯和标签栏 */
  status: Map<string, LiveSession>
  /** 是否至少拿到过一次快照：没有快照时不能断言「这条会话空闲」 */
  ready: boolean
}

const EMPTY = new Map<string, LiveSession>()

/** 内容一样就复用旧引用，否则每轮轮询都会把所有灯重渲一遍。 */
function sameStatus(left: Map<string, LiveSession>, right: Map<string, LiveSession>): boolean {
  if (left === right) return true
  if (left.size !== right.size) return false
  for (const [id, item] of left) {
    const other = right.get(id)
    if (!other) return false
    if (item.title !== other.title) return false
    if ((item.time?.busy ?? 0) !== (other.time?.busy ?? 0)) return false
    if ((item.time?.idle ?? 0) !== (other.time?.idle ?? 0)) return false
    if (Boolean(item.metadata?.error) !== Boolean(other.metadata?.error)) return false
  }
  return true
}

/**
 * 跨所有项目的会话状态：项目标签灯 + 会话标签灯共用一份数据。
 *
 * 和聊天区的 useChatRunning 是两套东西：那个只跟当前会话、用来切发送/停止按钮；
 * 这个跨所有项目、只喂灯和标签标题，所以切走标签或切到别的会话都不会丢状态。
 */
export function useSessionLights(connected: boolean, projectCount: number): SessionLights {
  const [dirs, setDirs] = useState<Set<string>>(() => new Set())
  const [status, setStatus] = useState<Map<string, LiveSession>>(EMPTY)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!connected) {
      // 断开时清掉快照：留着旧数据会让人以为灯是实时的
      setDirs((prev) => (prev.size === 0 ? prev : new Set()))
      setStatus((prev) => (prev.size === 0 ? prev : EMPTY))
      setReady(false)
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
        const sessions: SessionInfo[] = await listSessions(60)
        if (!alive) return
        const nextDirs = runningDirectories(sessions)
        setDirs((prev) => (sameSet(prev, nextDirs) ? prev : nextDirs))

        const next = new Map<string, LiveSession>()
        for (const session of sessions) {
          if (!session.id) continue
          next.set(session.id, {
            id: session.id,
            title: session.title,
            time: session.time,
            metadata: session.metadata,
          })
        }
        setStatus((prev) => (sameStatus(prev, next) ? prev : next))
        setReady(true)
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

  return { dirs, status, ready }
}
