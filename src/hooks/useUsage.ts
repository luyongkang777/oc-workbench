import { useCallback, useEffect, useRef, useState } from 'react'
import { getUsage, type UsagePeriod, type UsageResult } from '../api/usage'

/**
 * 用量面板的数据加载。
 *
 * 每次打开面板、切换范围/供应商都重新读一次日志（外壳侧按文件长度+修改时间
 * 缓存解析结果，重复读很便宜）。
 */
export function useUsage(open: boolean) {
  const [period, setPeriod] = useState<UsagePeriod>('today')
  const [provider, setProvider] = useState('')
  const [data, setData] = useState<UsageResult | null>(null)
  const [loading, setLoading] = useState(false)
  const alive = useRef(true)
  /** 请求序号：快速连点范围按钮时，只认最后一次的结果。 */
  const seq = useRef(0)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async (nextPeriod: UsagePeriod, nextProvider: string) => {
    const mine = ++seq.current
    setLoading(true)
    try {
      const result = await getUsage(nextPeriod, nextProvider || undefined)
      if (alive.current && mine === seq.current) setData(result)
    } catch (err) {
      if (alive.current && mine === seq.current) {
        setData({ ok: false, error: err instanceof Error ? err.message : '读取用量失败' })
      }
    } finally {
      if (alive.current && mine === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load(period, provider)
  }, [open, period, provider, load])

  const refresh = useCallback(() => {
    void load(period, provider)
  }, [load, period, provider])

  /** 换范围时清掉供应商筛选：新范围里可能根本没有这家，下拉会变成空白。 */
  const choosePeriod = useCallback((next: UsagePeriod) => {
    setProvider('')
    setPeriod(next)
  }, [])

  return { period, setPeriod: choosePeriod, provider, setProvider, data, loading, refresh }
}
