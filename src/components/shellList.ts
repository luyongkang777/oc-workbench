import { useEffect, useRef, useState } from 'react'
import {
  ShellGoneError,
  getShell,
  killShell,
  listShells,
  readShellOutput,
  type ShellInfo,
} from '../api/shells'
import { mergeSeen } from './shellMerge'

/**
 * Shell 列表的数据层。
 *
 * `GET /api/shell` 只返回**正在跑**的命令，跑完立刻消失。所以这里维护一份本地缓存，
 * 并对「本地认为在跑、服务端列表里没了」的条目用 `getShell` 补一次终态。要区分：
 * - 查到终态 / 404：真的结束了
 * - 请求抛错（网络抖动、5xx）：什么都没证明，保持原状等下一轮
 */

const LIST_MS = 2000
const OUT_MS = 1500

/** 对「本地在跑、服务端列表里没了」的条目补一次终态。请求失败时不动它们。 */
async function settleGone(
  seen: Map<string, ShellInfo>,
  freshIds: Set<string>,
  root: string,
  isAlive: () => boolean,
): Promise<void> {
  const stale = [...seen.values()].filter(
    (item) => item.status === 'running' && !freshIds.has(item.id),
  )
  if (stale.length === 0) return

  const results = await Promise.all(
    stale.map(async (item) => {
      try {
        return { id: item.id, info: await getShell(item.id, root), unknown: false }
      } catch {
        return { id: item.id, info: null, unknown: true }
      }
    }),
  )
  if (!isAlive()) return

  for (const result of results) {
    if (result.unknown) continue
    const prev = seen.get(result.id)
    if (!prev) continue
    // getShell 返回 null 表示 404：记录已被清理，本地收尾成已退出
    seen.set(result.id, result.info ?? { ...prev, status: 'exited' })
  }
}

/** 拉一轮列表并补齐终态；组件已卸载时返回 null。 */
async function pullOnce(
  root: string,
  seen: Map<string, ShellInfo>,
  isAlive: () => boolean,
): Promise<ShellInfo[] | null> {
  const fresh = await listShells(root)
  if (!isAlive()) return null
  await settleGone(seen, new Set(fresh.map((item) => item.id)), root, isAlive)
  if (!isAlive()) return null
  return fresh
}

/** 列表 + 终态补查。同一时刻只有一个刷新在途，避免慢请求叠加。 */
export function useShellList(
  root: string,
  connected: boolean,
  onCount?: (n: number) => void,
) {
  const [items, setItems] = useState<ShellInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const seenRef = useRef(new Map<string, ShellInfo>())
  const countRef = useRef(onCount)
  countRef.current = onCount

  useEffect(() => {
    if (!connected || !root) return
    let alive = true
    let inFlight = false

    async function refresh() {
      if (inFlight) return
      inFlight = true
      try {
        const fresh = await pullOnce(root, seenRef.current, () => alive)
        if (!fresh) return
        const merged = mergeSeen(seenRef.current, fresh)
        setItems(merged)
        setError(null)
        countRef.current?.(merged.filter((item) => item.status === 'running').length)
      } catch (err) {
        if (alive) setError((err as Error).message)
      } finally {
        inFlight = false
      }
    }

    void refresh()
    const timer = window.setInterval(refresh, LIST_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [connected, root, tick])

  /** kill 成功后本地立刻标成终态，别等服务端列表把它「补查成 exited」。 */
  function markKilled(id: string) {
    const prev = seenRef.current.get(id)
    if (prev) seenRef.current.set(id, { ...prev, status: 'killed' })
    setItems(mergeSeen(seenRef.current, []))
  }

  return { items, error, markKilled, refresh: () => setTick((v) => v + 1) }
}

/** 终止一条命令：成功后本地标终态，失败留一条提示。 */
export function useShellKill(root: string, onKilled: (id: string) => void, refresh: () => void) {
  const [killing, setKilling] = useState<string | null>(null)
  const [killError, setKillError] = useState<string | null>(null)

  async function kill(id: string) {
    setKilling(id)
    setKillError(null)
    try {
      await killShell(id, root)
      onKilled(id)
    } catch (err) {
      setKillError((err as Error).message)
    } finally {
      setKilling(null)
      refresh()
    }
  }

  return { killing, killError, kill }
}

/** 选中项的输出：运行中持续刷新；被删了才停，网络错误下一拍重试。 */
export function useShellOutput(
  selected: string | null,
  root: string,
  isRunning: boolean,
  /** 这条是我们自己刚终止的，它的 404 是预期结果，别报错。 */
  goneExpected: boolean,
) {
  const [output, setOutput] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!selected) return
    let alive = true
    let timer = 0

    async function pull() {
      try {
        const out = await readShellOutput(selected as string, root)
        if (!alive) return
        setOutput(out.text)
        setTruncated(out.truncated)
        setError(null)
        if (isRunning) timer = window.setTimeout(pull, OUT_MS)
      } catch (err) {
        if (!alive) return
        if (err instanceof ShellGoneError) {
          if (!goneExpected) setError(err.message)
          return
        }
        setError((err as Error).message)
        if (isRunning) timer = window.setTimeout(pull, OUT_MS)
      }
    }

    void pull()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [selected, root, isRunning, goneExpected])

  return {
    output,
    truncated,
    error,
    reset: () => {
      setOutput('')
      setTruncated(false)
      setError(null)
    },
  }
}
