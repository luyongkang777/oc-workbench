import { useEffect, useState } from 'react'
import { killPty, listSessionTerminals, readTerminal, type PtyInfo } from '../api/terminal'
import { cleanTerminalOutput } from './shellText'

/**
 * 会话的持久终端（PTY）列表。
 * 注意：必须走会话维度接口，顶层 `/api/pty` 是另一套管理器，id 不能混用。
 */

const LIST_MS = 2500
const SNAP_MS = 1500

export function ptyLabel(item: PtyInfo): string {
  const text = (item.userTitle ?? '').trim() || (item.title ?? '').trim() || item.command
  return text.length > 88 ? `${text.slice(0, 88)}…` : text
}

function PtyRow({ item, active, onPick }: {
  item: PtyInfo
  active: boolean
  onPick: (id: string) => void
}) {
  return (
    <button
      type="button"
      data-id={item.id}
      className={`shell-row${active ? ' active' : ''}`}
      onClick={() => onPick(item.id)}
    >
      <span className={`shell-dot ${item.status === 'running' ? 'running' : 'exited'}`} />
      <span className="shell-cmd" title={ptyLabel(item)}>{ptyLabel(item)}</span>
      <span className="shell-meta">{item.status === 'running' ? '运行中' : '已退出'}</span>
      <span className="shell-pid">pid {item.pid}</span>
    </button>
  )
}

function PtyDetail({ item, snapshot, error, killing, onKill }: {
  item: PtyInfo
  snapshot: string
  error: string | null
  killing: boolean
  onKill: () => void
}) {
  return (
    <div className="shell-detail">
      <div className="shell-detail-head">
        <span className="shell-detail-title">{item.status === 'running' ? '运行中' : '已退出'}</span>
        <span className="shell-detail-exit">
          {item.exitCode === undefined ? '' : `退出码 ${item.exitCode}`}
        </span>
        <span className="shell-spacer" />
        <button type="button" className="shell-kill" onClick={onKill} disabled={killing}>
          {killing ? '移除中' : '移除'}
        </button>
      </div>
      <pre className="shell-output">{cleanTerminalOutput(snapshot) || '（还没有输出）'}</pre>
    </div>
  )
}

function PtyEmpty({ connected, error }: { connected: boolean; error: string | null }) {
  return (
    <div className="shell-empty">
      {error ? <div className="shell-error">{error}</div> : null}
      {connected ? '这个会话下没有持久终端。' : '等待后端连接…'}
    </div>
  )
}

/** 会话终端列表。换会话时立刻清空旧列表，避免新会话首次返回前还列着上个会话的终端。 */
function usePtyList(sessionID: string | undefined, root: string, connected: boolean, visible: boolean) {
  const [items, setItems] = useState<PtyInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    setItems([])
    setError(null)
    if (!connected || !root || !sessionID || !visible) return
    let alive = true
    let inFlight = false

    async function refresh() {
      if (inFlight) return
      inFlight = true
      try {
        const fresh = await listSessionTerminals(sessionID as string, root)
        if (!alive) return
        setItems(fresh)
        setError(null)
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
  }, [connected, root, sessionID, visible, tick])

  return { items, error, refresh: () => setTick((v) => v + 1) }
}

/** 快照轮询：终端还在就继续；已被移除就停；瞬时错误下一拍重试。 */
function usePtySnapshot(selected: string | null, isRunning: boolean) {
  const [snapshot, setSnapshot] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!selected) return
    let alive = true
    let timer = 0

    async function pull() {
      try {
        const snap = await readTerminal(selected as string)
        if (!alive) return
        setSnapshot(snap.text)
        setError(null)
        if (isRunning) timer = window.setTimeout(pull, SNAP_MS)
      } catch (err) {
        if (!alive) return
        const message = (err as Error).message
        setError(message)
        // 「已经不在了」是终态，别继续打；其余（网络/5xx）下一拍重试
        if (isRunning && !message.includes('已经不在了')) {
          timer = window.setTimeout(pull, SNAP_MS)
        }
      }
    }

    void pull()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [selected, isRunning])

  return {
    snapshot,
    error,
    reset: () => {
      setSnapshot('')
      setError(null)
    },
  }
}

function PtyBody({ items, selected, active, error, killError, snapshot, snapError, killing, onPick, onKill }: {
  items: PtyInfo[]
  selected: string | null
  active?: PtyInfo
  error: string | null
  killError: string | null
  snapshot: string
  snapError: string | null
  killing: string | null
  onPick: (id: string) => void
  onKill: (id: string) => void
}) {
  return (
    <div className="shell-panel">
      <div className="shell-list">
        {items.map((item) => (
          <PtyRow key={item.id} item={item} active={item.id === selected} onPick={onPick} />
        ))}
      </div>
      {error ? <div className="shell-error">{error}</div> : null}
      {killError ? <div className="shell-error">{killError}</div> : null}
      {active ? (
        <PtyDetail
          item={active}
          snapshot={snapshot}
          error={snapError}
          killing={killing === active.id}
          onKill={() => onKill(active.id)}
        />
      ) : null}
    </div>
  )
}

function usePtyKill(root: string, refresh: () => void, onKilled: () => void) {
  const [killing, setKilling] = useState<string | null>(null)
  const [killError, setKillError] = useState<string | null>(null)

  async function kill(id: string) {
    setKilling(id)
    setKillError(null)
    try {
      await killPty(id)
      onKilled()
    } catch (err) {
      setKillError((err as Error).message)
    } finally {
      setKilling(null)
      refresh()
    }
  }

  return { killing, killError, kill }
}

type Props = {
  root: string
  connected: boolean
  visible: boolean
  sessionID?: string
}

export default function PtySessions({ root, connected, visible, sessionID }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const { items, error, refresh } = usePtyList(sessionID, root, connected, visible)
  const active = items.find((item) => item.id === selected)
  const { snapshot, error: snapError, reset } = usePtySnapshot(selected, active?.status === 'running')
  const { killing, killError, kill } = usePtyKill(root, refresh, () => {
    setSelected(null)
    reset()
  })

  // 换会话时旧选中不能留着：列表已经换成新会话的，详情区会指向不存在的东西
  useEffect(() => {
    setSelected(null)
    reset()
  }, [sessionID])

  useEffect(() => {
    if (selected && !items.some((item) => item.id === selected)) {
      setSelected(null)
      reset()
    }
  }, [items, selected])

  if (!sessionID) return <div className="shell-empty">当前还没有会话，终端要挂在会话下。</div>
  if (items.length === 0) return <PtyEmpty connected={connected} error={error} />

  return (
    <PtyBody
      items={items}
      selected={selected}
      active={active}
      error={error}
      killError={killError}
      snapshot={snapshot}
      snapError={snapError}
      killing={killing}
      onPick={(id) => {
        setSelected(id)
        reset()
      }}
      onKill={(id) => void kill(id)}
    />
  )
}
