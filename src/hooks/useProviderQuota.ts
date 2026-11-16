import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getProviderQuota,
  getProviderUsage,
  type ProviderQuota,
  type ProviderUsage,
} from '../api/providerQuota'

/**
 * 服务商额度与本机用量。
 *
 * 从 `useProviderPanel` 拆出来：面板本身只关心「配置怎么读写」，
 * 额度查询（网络、失败降级、手动刷新）是另一件事。
 *
 * 三条规则：
 *   1. 单条失败不抛：那一条记成 `ok: false`，界面显示「额度查询失败」，不影响其它；
 *   2. `loadQuota` 返回本次结果，刷新按钮据此统计「几个查询失败」；
 *   3. 面板关掉后不再写 state（`alive`），但结果照常返回。
 */
export function useProviderQuota(root: string) {
  const [quota, setQuota] = useState<Record<string, ProviderQuota>>({})
  const [usage, setUsage] = useState<Record<string, ProviderUsage>>({})
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const loadQuota = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return [] as Array<readonly [string, ProviderQuota]>
    const entries = await Promise.all(
      ids.map(async (id) => {
        try {
          return [id, await getProviderQuota(id)] as const
        } catch (err) {
          return [id, { ok: false, error: err instanceof Error ? err.message : '额度查询失败' }] as const
        }
      }),
    )
    // 面板已关闭就别写 state，但把结果照常返回给刷新按钮做失败统计
    if (!alive.current) return entries
    setQuota((cur) => {
      const next = { ...cur }
      for (const [id, value] of entries) next[id] = value
      return next
    })
    return entries
  }, [])

  /** 本机累计用量（拿不到就保持空表，界面自动省略这一行）。 */
  const loadUsage = useCallback(async () => {
    if (!root) return
    const fresh = await getProviderUsage(root)
    // 接口失败也返回空表（区分不了「真没用量」），空表就别把已有的用量擦掉，
    // 否则统计接口一挂、点一次刷新，「本机已用 … tokens」会整片消失。
    if (alive.current && Object.keys(fresh).length > 0) setUsage(fresh)
  }, [root])

  /** 删掉一条 provider 时把它那格额度一起清掉。 */
  const drop = useCallback((id: string) => {
    setQuota((cur) => {
      const next = { ...cur }
      delete next[id]
      return next
    })
  }, [])

  /**
   * 手动「刷新额度」：额度与用量一起重拉，返回要显示的一行提示。
   *
   * 空串表示「正在刷新中，什么都不用说」—— 调用方据此避免清空已有提示。
   */
  const refresh = useCallback(
    async (ids: string[]): Promise<string> => {
      if (busy) return ''
      setBusy(true)
      try {
        const entries = ids.length > 0 ? await loadQuota(ids) : []
        await loadUsage()
        if (ids.length === 0) return '还没有配置服务商，没有额度可查'
        // 逐条失败是常态（key 过期 / 控制台没开放），别把「全都查失败」说成刷新成功。
        const failed = entries.filter(([, value]) => !value.ok).length
        return failed > 0 ? `额度已刷新（${failed} 个查询失败）` : '额度已刷新'
      } catch (err) {
        return err instanceof Error ? err.message : '刷新额度失败'
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    [busy, loadQuota, loadUsage],
  )

  return { quota, usage, busy, loadQuota, loadUsage, drop, refresh }
}
