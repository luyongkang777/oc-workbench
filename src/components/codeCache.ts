/** CodeView 的页缓存模型：一页可能不足 200 行（服务端 512KB 上限/超长行截断）。 */

export type Page = { start: number; lines: string[]; next: number; eof: boolean }
export type Failure = { start: number; error: string }
export type Entry = Page | Failure

export function isFailure(entry: Entry): entry is Failure {
  return 'error' in entry
}

/** 找覆盖该行的页；找不到说明这一行还没加载。 */
export function coveringEntry(cache: Map<number, Entry>, line: number): Entry | null {
  for (const entry of cache.values()) {
    if (entry.start > line) continue
    if (isFailure(entry)) {
      if (entry.start === line) return entry
      continue
    }
    if (line < entry.start + entry.lines.length) return entry
  }
  return null
}

/** 已确认的文件结尾（任一 eof 页的 next），用来避免对着过期索引反复补页。 */
export function loadedEnd(cache: Map<number, Entry>): number | null {
  let end: number | null = null
  for (const entry of cache.values()) {
    if (isFailure(entry) || !entry.eof) continue
    end = end === null ? entry.next : Math.max(end, entry.next)
  }
  return end
}
