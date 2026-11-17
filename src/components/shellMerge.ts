import type { ShellInfo } from '../api/shells'

/**
 * Shell 列表缓存的合并规则（纯函数，方便单测）。
 *
 * 两条关键约定：
 * 1. 本地已记成终态的条目，不被服务端返回的 running 盖回去
 *    —— DELETE / kill 生效前，列表接口还会返回一次旧状态。
 * 2. 裁剪到 MAX_ITEMS 时运行中的优先保留，否则命令多的时候
 *    还在跑的老条目会被挤出列表，下一轮又跳回来，列表会抖。
 */

export const MAX_ITEMS = 12

export function mergeSeen(seen: Map<string, ShellInfo>, fresh: ShellInfo[]): ShellInfo[] {
  for (const item of fresh) {
    const prev = seen.get(item.id)
    if (prev && prev.status !== 'running' && item.status === 'running') continue
    seen.set(item.id, item)
  }
  const rank = (item: ShellInfo) => (item.status === 'running' ? 0 : 1)
  const list = [...seen.values()].sort((a, b) => rank(a) - rank(b) || b.time.started - a.time.started)
  const kept = list.slice(0, MAX_ITEMS)
  if (kept.length < seen.size) {
    const keep = new Set(kept.map((item) => item.id))
    for (const id of [...seen.keys()]) if (!keep.has(id)) seen.delete(id)
  }
  return kept
}
