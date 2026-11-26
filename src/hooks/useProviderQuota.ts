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
 * 四条规则：
 *   1. 单条失败不抛：那一条记成 `ok: false`，界面显示「额度查询失败」，不影响其它；
 *   2. `loadQuota` 返回本次结果，刷新按钮据此统计「几个查询失败」；
 *   3. 面板关掉后不再写 state（`alive`），但结果照常返回；
 *   4. **模块级缓存**：额度是外网查询（每家最多 10 秒），反复开关面板不该反复等。
 *      60 秒内直接复用；过期了也先把旧值摆出来，再后台刷新（stale-while-revalidate）。
 */
const CACHE_TTL = 60_000

type Cache = {
  quotaAt: number
  quota: Record<string, ProviderQuota>
  usage: Record<string, { at: number; values: Record<string, ProviderUsage> }>
}

const cache: Cache = { quotaAt: 0, quota: {}, usage: {} }

export function useProviderQuota(root: string) {
  const [quota, setQuota] = useState<Record<string, ProviderQuota>>(cache.quota)
  const [usage, setUsage] = useState<Record<string, ProviderUsage>>(cache.usage[root]?.values ?? {})
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const loadQuota = useCallback(async (ids: string[], force = false) => {
    if (ids.length === 0) return [] as Array<readonly [string, ProviderQuota]>

    // 有旧值先摆出来：面板一打开就有数字，不用盯着空白等网络。
    let targets = ids
    if (!force && Object.keys(cache.quota).length > 0) {
      if (alive.current) setQuota(cache.quota)
      if (Date.now() - cache.quotaAt < CACHE_TTL) {
        // 缓存新鲜的条目直接用；缓存里没有的（新加的 provider）仍然要查。
        const missing = ids.filter((id) => !cache.quota[id])
        if (missing.length === 0) {
          return ids
            .filter((id) => cache.quota[id])
            .map((id) => [id, cache.quota[id]] as const)
        }
        targets = missing
      }
    }

    const entries = await Promise.all(
      targets.map(async (id) => {
        try {
          return [id, await getProviderQuota(id)] as const
        } catch (err) {
          return [id, { ok: false, error: err instanceof Error ? err.message : '额度查询失败' }] as const
        }
      }),
    )

    for (const [id, value] of entries) cache.quota[id] = value
    cache.quotaAt = Date.now()

    // 面板已关闭就别写 state，但把结果照常返回给刷新按钮做失败统计
    if (!alive.current) return entries
    setQuota({ ...cache.quota })
    return entries
  }, [])

  /** 本机累计用量（拿不到就保持空表，界面自动省略这一行）。 */
  const loadUsage = useCallback(
    async (force = false) => {
      if (!root) return
      const cached = cache.usage[root]
      if (!force && cached && Date.now() - cached.at < CACHE_TTL) {
        if (alive.current) setUsage(cached.values)
        return
      }
      const fresh = await getProviderUsage(root)
      // 接口失败也返回空表（区分不了「真没用量」），空表就别把已有的用量擦掉，
      // 否则统计接口一挂、点一次刷新，「本机已用 … tokens」会整片消失。
      if (Object.keys(fresh).length > 0) {
        cache.usage[root] = { at: Date.now(), values: fresh }
        if (alive.current) setUsage(fresh)
      }
    },
    [root],
  )

  /** 删掉一条 provider 时把它那格额度一起清掉。 */
  const drop = useCallback((id: string) => {
    delete cache.quota[id]
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
   * 手动刷新一律 `force`，不吃缓存。
   */
  const refresh = useCallback(
    async (ids: string[]): Promise<string> => {
      if (busy) return ''
      setBusy(true)
      try {
        const entries = ids.length > 0 ? await loadQuota(ids, true) : []
        await loadUsage(true)
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
