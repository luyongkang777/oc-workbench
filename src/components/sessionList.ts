/**
 * 历史会话选择器用到的纯函数：按关键字过滤 + 按日期分组。
 *
 * 为什么要单独一个文件：
 *   ChatHeader 已经 400 多行，再塞分组和过滤会超「单文件 300 行」的硬线；
 *   而且这两件事都是纯数据变换，拆出来就能直接单测（不进 React、不碰 fetch）。
 *
 * 不 import api/chat：那个模块会拖进 fetch / token，node 单测跑不起来。
 */

/** 列表里真正用到的字段。id 必须有；其余按服务端返回的来。 */
export type ListSession = {
  id: string
  title?: string
  time?: {
    created?: number
    updated?: number
    busy?: number
    idle?: number
  }
}

/** 「最后一次对话」时间：updated 优先，退到 created。和 api/chat 的判据一致。 */
export function listSessionAt(session: ListSession): number | undefined {
  const at = session.time?.updated ?? session.time?.created
  return typeof at === 'number' && at > 0 ? at : undefined
}

/**
 * 关键字过滤。
 *
 * 只匹配标题（会话列表里用户认得的就是标题），空串/纯空白视为不过滤。
 * 大小写不敏感：中文没影响，英文标题（写代码时常见的 fix/login）能少打一遍。
 */
export function filterSessions<T extends ListSession>(list: T[], keyword: string): T[] {
  const needle = keyword.trim().toLowerCase()
  if (!needle) return list
  return list.filter((session) => (session.title ?? '').toLowerCase().includes(needle))
}

export type SessionGroup<T> = {
  /** 稳定 key，React 列表用 */
  key: string
  label: string
  items: T[]
}

/** 把时间归到「那一天的零点」，用来比较自然日之差（不是 24 小时之差）。 */
function startOfDay(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * 按日期分组：今天 / 昨天 / 本周（近 7 天）/ 更早。
 *
 * 为什么按自然日而不是「多少小时前」：翻历史时人的参照系是日历，
 * 「昨天 23:40」和「今天 00:10」差 30 分钟但要分两组。
 * 没有时间戳的会话统一归到「更早」，不丢条目。
 */
export function groupSessions<T extends ListSession>(
  list: T[],
  now = Date.now(),
): SessionGroup<T>[] {
  const today = startOfDay(now)
  const yesterday = today - 86_400_000
  const weekAgo = today - 6 * 86_400_000

  const buckets: SessionGroup<T>[] = [
    { key: 'today', label: '今天', items: [] },
    { key: 'yesterday', label: '昨天', items: [] },
    { key: 'week', label: '近 7 天', items: [] },
    { key: 'older', label: '更早', items: [] },
  ]

  for (const session of list) {
    const at = listSessionAt(session)
    if (at === undefined) {
      buckets[3].items.push(session)
      continue
    }
    const day = startOfDay(at)
    if (day >= today) buckets[0].items.push(session)
    else if (day >= yesterday) buckets[1].items.push(session)
    else if (day >= weekAgo) buckets[2].items.push(session)
    else buckets[3].items.push(session)
  }

  // 空分组不渲染：历史少的项目不该出现四行小标题
  return buckets.filter((group) => group.items.length > 0)
}
