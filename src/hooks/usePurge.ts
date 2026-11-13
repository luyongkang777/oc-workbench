import { useCallback, useEffect, useRef, useState } from 'react'
import { getPurgeStatus, setPurgeEnabled, type PurgeStatus } from '../api/purge'

export type PurgeController = {
  status: PurgeStatus | null
  loading: boolean
  busy: boolean
  error: string | null
  /** 切换开关；不传就取反。写入后延迟再读一次，等插件按新配置跑过一轮。 */
  toggle: (enabled?: boolean) => Promise<void>
  reload: () => Promise<void>
}

/**
 * 破甲开关的状态。
 *
 * 开关本体在插件配置文件里，工作台只是读写那一个字段，所以这里没有长连接：
 * 挂载时读一次、窗口重新获得焦点时读一次、切换后按 1.2 秒 / 5.5 秒各补读一次
 * （插件按 mtime 缓存配置 5 秒，太早读回来的 state 还是旧那一轮）。
 */
export function usePurge(connected: boolean): PurgeController {
  const [status, setStatus] = useState<PurgeStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  const timers = useRef<number[]>([])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      for (const timer of timers.current) window.clearTimeout(timer)
      timers.current = []
    }
  }, [])

  const reload = useCallback(async () => {
    try {
      const next = await getPurgeStatus()
      if (!alive.current) return
      setStatus(next)
      setError(next.ok ? null : next.error ?? '读取破甲配置失败')
    } catch (err) {
      if (!alive.current) return
      setError(err instanceof Error ? err.message : '读取破甲配置失败')
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload, connected])

  // 用户可能刚在终端里 /purge on|off 或手改了配置，回到窗口时同步一次
  useEffect(() => {
    const onFocus = () => void reload()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reload])

  const toggle = useCallback(
    async (enabled?: boolean) => {
      if (busy || !status) return
      const next = typeof enabled === 'boolean' ? enabled : !status.enabled
      setBusy(true)
      setError(null)
      // 先动界面：写盘通常几毫秒，等往返再变色会显得卡
      setStatus((prev) => (prev ? { ...prev, enabled: next } : prev))
      try {
        const saved = await setPurgeEnabled(next)
        if (!alive.current) return
        setStatus(saved)
        setError(saved.ok ? null : saved.error ?? '切换失败')
        for (const delay of [1200, 5500]) {
          const timer = window.setTimeout(() => {
            void getPurgeStatus()
              .then((fresh) => {
                if (alive.current) setStatus(fresh)
              })
              .catch(() => {
                /* 补读失败不覆盖已写入的状态 */
              })
          }, delay)
          timers.current.push(timer)
        }
      } catch (err) {
        if (!alive.current) return
        setError(err instanceof Error ? err.message : '切换失败')
        // 写盘失败：回到磁盘上真实的值
        void reload()
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    [busy, status, reload],
  )

  return { status, loading, busy, error, toggle, reload }
}
