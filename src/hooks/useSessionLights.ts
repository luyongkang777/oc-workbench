import { useEffect, useState } from 'react'

import { listSessions, type SessionInfo } from '../api/chat'
import { runningDirectories, sameSet, type SessionLike } from '../components/projectStatus.ts'

/**
 * 轮询间隔。
 *
 * 只查一个接口（全局最新 60 条会话），所以项目/会话再多也不会变成 N 个请求。
 *
 * 远程访问（手机走公网 + ssh 隧道）时单个请求要 60~90ms，1.5 秒一轮是纯浪费；
 * 4 秒既不耽误「点发送后灯变黄」，又能把后台请求砍掉三分之二。
 */
const POLL_MS = 4000
/** 全空闲时的间隔：没人跑就没人盯灯，10 秒一次足够。 */
const IDLE_POLL_MS = 10_000

/** 与 projectStatus 的 SessionLike 对齐，多带标题和 id（标签栏要用）。 */
export type LiveSession = SessionLike & { id?: string; title?: string }

export type SessionLights = {
  /** 正在生成的目录（normKey 集合），喂给顶栏项目标签 */
  dirs: Set<string>
  /**
   * 会话 id → 最新 title/time/metadata，喂给状态灯和标签栏。
   * 查不到某条会话 = 这一轮没拿到它的状态，调用方应显示灰灯（不猜空闲）。
   */
  status: Map<string, LiveSession>
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

  useEffect(() => {
    if (!connected) {
      // 断开时清掉快照：留着旧数据会让人以为灯是实时的
      setDirs((prev) => (prev.size === 0 ? prev : new Set()))
      setStatus((prev) => (prev.size === 0 ? prev : EMPTY))
      return
    }
    let alive = true
    let timer = 0

    // 自适应间隔：有会话在跑（含子会话）就勤查，全空闲就放慢。
    // 手机上常驻页面时，空闲期的请求量能降到原来的 1/4。
    const schedule = (delay = POLL_MS) => {
      if (alive) timer = window.setTimeout(tick, delay)
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
        // 空闲时放宽到 IDLE_POLL_MS；一旦有会话在跑就回到 POLL_MS。
        schedule(nextDirs.size > 0 ? POLL_MS : IDLE_POLL_MS)
        return
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

  return { dirs, status }
}
