import { useCallback, useEffect, useRef, useState } from 'react'
import { applyUpdate, getUpdateProgress, type UpdateProgress } from '../api/update'
import {
  IDLE_TASK,
  backendStillRunning,
  mergeProgress,
  taskSettled,
  type UpdateTask,
} from '../components/updateProgressFormat'

/** 进度轮询间隔：外壳每读 64KB 更新一次状态，400ms 采一次足够顺滑。 */
const POLL_MS = 400
/**
 * 客户端超时后继续跟随的时长上限。
 *
 * `apply` 的 HTTP 超时是 180 秒，慢网下后端可能还在下载并最终成功重启；
 * 这时界面不能钉在「失败」上。但也得有上限，避免永远挂在「下载中」。
 */
const FOLLOW_MAX_MS = 10 * 60 * 1000

/**
 * 一次更新任务（下载 → 校验 → 重启）。
 *
 * 为什么放在 `UpdateEntry` 这一层而不是弹窗里：弹窗关掉会卸载，更新却还在跑；
 * 重新打开时要从这里拿回进度，而不是重新检查一遍把它盖掉。
 *
 * 成功之后 `settled=true`：本次进程内不再自动检查更新（避免「刚更新完又提示有新版」）。
 */
export function useUpdateTask(onSettled?: () => void) {
  const [task, setTask] = useState<UpdateTask>(IDLE_TASK)
  const alive = useRef(true)
  const pollTimer = useRef<number | null>(null)
  const running = useRef(false)
  /** 第几轮更新。上一轮的轮询响应可能是「已失败」，不能让它把新一轮改回去。 */
  const attempt = useRef(0)
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (pollTimer.current !== null) window.clearInterval(pollTimer.current)
    }
  }, [])

  /** 采一次进度；到终态就把计时器停掉，不再空转。 */
  const pollOnce = useCallback(
    async (mine: number, startedAt: number) => {
      try {
        const progress = await getUpdateProgress()
        if (!alive.current || attempt.current !== mine) return
        if (progress.stage === 'restarting') {
          stopPolling()
          setTask((cur) => mergeProgress(cur, progress))
          onSettledRef.current?.()
          return
        }
        if (progress.stage === 'failed') {
          stopPolling()
          setTask((cur) => mergeProgress(cur, progress))
          return
        }
        if (Date.now() - startedAt > FOLLOW_MAX_MS) {
          stopPolling()
          setTask((cur) => ({
            ...cur,
            phase: 'failed',
            error: '更新长时间未完成（可能仍在后台进行），稍后回来看看',
          }))
          return
        }
        setTask((cur) => mergeProgress(cur, progress))
      } catch {
        // 进程可能正在退出，或短暂连不上：忽略，等 apply 的返回/下一轮采样
      }
    },
    [stopPolling],
  )

  const start = useCallback(
    async (version: string | null) => {
      if (running.current) return
      running.current = true
      attempt.current += 1
      const mine = attempt.current
      const startedAt = Date.now()
      setTask({ phase: 'downloading', done: 0, total: 0, error: null, version })

      stopPolling()
      pollTimer.current = window.setInterval(() => {
        void pollOnce(mine, startedAt)
      }, POLL_MS)

      try {
        await applyUpdate()
        if (!alive.current || attempt.current !== mine) return
        stopPolling()
        setTask((cur) => {
          const done = cur.total > 0 ? cur.total : cur.done
          return { ...cur, phase: 'restarting', done, total: done, error: null }
        })
        onSettledRef.current?.()
      } catch (err) {
        if (!alive.current || attempt.current !== mine) return
        // 客户端超时 / 连接断开 **不等于** 后端没在下载：180 秒超时后后端
        // 仍可能在跑并最终成功重启。这时要按真实进度决定「继续跟随」还是
        // 「报失败」，不能把界面钉死在失败上。
        let progress: UpdateProgress | null = null
        try {
          progress = await getUpdateProgress()
        } catch {
          progress = null
        }
        if (!alive.current || attempt.current !== mine) return
        if (progress && progress.stage === 'restarting') {
          stopPolling()
          setTask((cur) => mergeProgress(cur, progress))
          onSettledRef.current?.()
          return
        }
        if (backendStillRunning(progress)) {
          // 后端还在下载/校验：保留 downloading 状态，轮询继续跟着。
          if (progress) setTask((cur) => mergeProgress(cur, progress))
          return
        }
        stopPolling()
        setTask((cur) => ({
          ...cur,
          phase: 'failed',
          error: err instanceof Error ? err.message : '更新失败',
        }))
      } finally {
        running.current = false
      }
    },
    [pollOnce, stopPolling],
  )

  return { task, start, settled: taskSettled(task) }
}
