import { useEffect, useMemo, useRef, useState } from 'react'

import { listMessages, listSubagentTree, type SessionInfo } from '../api/chat'
import {
  isExpanded,
  buildSubagentRows,
  fmtCost,
  fmtElapsed,
  fmtTokens,
  isStuck,
  pickActivity,
  summarize,
  type Activity,
  type SubagentMode,
  type SubagentRow,
} from './subagent'

/**
 * 轮询间隔。
 *
 * 面板一轮要爬三层树：先问主会话的直接子会话（1 个请求），再为每个子会话问
 * 孙子（N 个请求）。实测 8 个子智能体时每轮 9 个请求，1.2 秒一轮 = 8.8 req/s。
 * 所以分成三档：有在跑的才用快档；都已经结束就慢档（它们不会再派新的）；
 * 一个子智能体都没有用最慢档。
 */
const POLL_RUNNING_MS = 1200
const POLL_SETTLED_MS = 5000

/** 「已确认没有子孙」的记录有效期：过期后重新问一次，防止漏掉后来派生的孙子。 */
const LEAF_TTL_MS = 15_000
const POLL_IDLE_MS = 8000

/** 时间刷新（耗时每秒在跳，但不需要重查服务端）。 */
const TICK_MS = 1000

/** 最多给多少个「在跑」的子会话单独拉消息来显示工具名。再多就是浪费请求了。 */
const ACTIVITY_LIMIT = 8


type Props = {
  /** 当前主会话 id：只看它的子孙，不串到别的窗口 */
  sessionID: string | undefined
  connected: boolean
  /** 点某一行：跳到那个子会话 */
  onOpen: (sessionID: string) => void
  /**
   * auto   = 有子智能体才展开（没子智能体只留一条细条，不白占宽度）
   * open   = 用户手动展开；closed = 用户手动收起
   */
  mode: SubagentMode
  onToggle: (next: SubagentMode) => void
}

/**
 * 子智能体监视面板。
 *
 * 主会话派子智能体时，右侧能看到：谁在跑、跑哪个工具、多久了、烧了多少。
 * 点一行就跳过去看它的完整对话。
 *
 * 数据来源：
 *   listSubagentTree()  自己爬 parentID 拿子孙会话（服务端没有整棵树接口）
 *   listMessages()      只给「在跑」的最多 8 个拉消息，用来显示当前工具名
 *
 * 为什么不全量拉消息：子会话一多（一次派 5~6 个很常见），每个都拉一次完整历史
 * 会把本地服务打满，而且历史越长越慢。只有「在跑」的才需要知道当下在干什么。
 */
export default function SubagentPanel({ sessionID, connected, onOpen, mode, onToggle }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activities, setActivities] = useState<Record<string, Activity>>({})
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState<string | null>(null)

  /** 上一次拉消息的会话 id 集合：用来判断「哪些还在跑」，避免重复拉同一个 */
  const pulledRef = useRef<Record<string, number>>({})

  /**
   * 已确认「没有子孙、而且已经跑完」的子会话 → 上次确认时间。
   *
   * 面板每轮都要为每个直接子会话问一次孙子，8 个子智能体就是 9 个请求。
   * 跑完的子会话不可能再派新的，所以 15 秒内不再问它，请求数直接降到 2~3 个。
   */
  const leavesRef = useRef<Record<string, number>>({})

  // ---- 每秒刷新一次耗时（不发请求）
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  // ---- 轮询子会话树
  useEffect(() => {
    if (!connected || !sessionID || mode === 'closed') {
      setSessions((prev) => (prev.length === 0 ? prev : []))
      setActivities((prev) => (Object.keys(prev).length === 0 ? prev : {}))
      setError(null)
      return
    }

    let alive = true
    let timer = 0
    /** 三档轮询：有在跑的 → 快；都结束了 → 慢；一个都没有 → 最慢 */
    let nextDelay = POLL_IDLE_MS
    const schedule = () => {
      if (alive) timer = window.setTimeout(tick, nextDelay)
    }

    async function tick() {
      // 窗口在后台不查：没人看，省掉请求
      if (document.hidden) {
        schedule()
        return
      }
      try {
        // 15 秒内已确认没有子孙、而且早就跑完的子会话，不再为它问孙子
        const nowMs = Date.now()
        const skip = new Set(
          Object.entries(leavesRef.current)
            .filter(([, at]) => nowMs - at < LEAF_TTL_MS)
            .map(([id]) => id),
        )
        const tree = await listSubagentTree(sessionID!, 3, skip)
        if (!alive) return
        setSessions(tree)
        setError(null)

        // 更新「确认没有子孙」的集合：只有在跑完、且确实没孩子的才算稳定
        const parents = new Set(
          tree.map((node) => node.parentID).filter((id): id is string => Boolean(id)),
        )
        const nextLeaves: Record<string, number> = {}
        for (const node of tree) {
          if (node.depth !== 1) continue
          const running = (node.time?.busy ?? 0) > (node.time?.idle ?? 0)
          // 在跑的随时会派新的；已经有孩子的当然不是叶子
          if (running || parents.has(node.id)) continue
          // 这一轮真的问过它才刷新时间戳；被跳过就沿用旧到期时间
          nextLeaves[node.id] = skip.has(node.id) ? (leavesRef.current[node.id] ?? nowMs) : nowMs
        }
        leavesRef.current = nextLeaves

        // 只给「在跑」的拉消息，拿当前工具名
        const running = tree
          .filter((session) => {
            const busy = session.time?.busy ?? 0
            const idle = session.time?.idle ?? 0
            return busy > idle
          })
          .slice(0, ACTIVITY_LIMIT)
        // 下一轮节奏：有人在跑才需要跟手；都结束了它们不会再派新的
        nextDelay =
          running.length > 0 ? POLL_RUNNING_MS : tree.length > 0 ? POLL_SETTLED_MS : POLL_IDLE_MS

        const runningIDs = new Set(running.map((session) => session.id))
        // 不在跑的把它缓存清掉，免得面板一直显示它最后那句话（注释说的就是这个，
        // 但以前只清了 pulledRef 这个节流表，activities 一直没清）
        pulledRef.current = Object.fromEntries(
          Object.entries(pulledRef.current).filter(([id]) => runningIDs.has(id)),
        )
        setActivities((prev) => {
          const keys = Object.keys(prev)
          if (keys.every((id) => runningIDs.has(id))) return prev
          const next: Record<string, Activity> = {}
          for (const id of keys) if (runningIDs.has(id)) next[id] = prev[id]
          return next
        })

        await Promise.all(
          running.map(async (session) => {
            // 同一个子会话 2 秒内不重复拉：它可能在一轮里跑很久
            const last = pulledRef.current[session.id] ?? 0
            if (Date.now() - last < 2000) return
            pulledRef.current[session.id] = Date.now()
            try {
              const page = await listMessages(session.id, 1)
              if (!alive) return
              const activity = pickActivity(page.messages)
              setActivities((prev) => ({ ...prev, [session.id]: activity }))
            } catch {
              // 单个子会话拉失败不影响其他行
            }
          }),
        )
      } catch (err) {
        if (alive) setError((err as Error).message)
      }
      schedule()
    }

    void tick()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [connected, sessionID, mode])

  const rows = useMemo(() => buildSubagentRows({ sessions, now, activities }), [sessions, now, activities])
  const summary = useMemo(() => summarize(rows), [rows])

  /**
   * 展开还是收成细条：
   *   closed                  → 细条（用户明确收起）
   *   open                    → 面板（用户明确展开）
   *   auto 且有子智能体       → 面板（有事可看就自动出来）
   *   auto 且没有子智能体     → 细条（不为了一个空列表吃掉 320px）
   */
  const expanded = isExpanded(mode, rows.length)

  if (!expanded) {
    return (
      <div className="subagent-bar">
        <button
          type="button"
          className="subagent-bar-btn"
          onClick={() => onToggle('open')}
          title="展开子智能体面板"
        >
          <span className="subagent-bar-icon">▸</span>
          <span>子智能体</span>
          {summary.running > 0 ? <span className="subagent-bar-count">{summary.running}</span> : null}
        </button>
      </div>
    )
  }

  return (
    <aside className="subagent-pane">
      <div className="subagent-head">
        <button type="button" className="subagent-head-toggle" onClick={() => onToggle('closed')} title="收起">
          ▾
        </button>
        <span className="subagent-head-title">子智能体</span>
        <span className="subagent-head-summary">{summary.text}</span>
        {summary.outTokens > 0 ? (
          <span className="subagent-head-tokens">{fmtTokens(summary.outTokens)} tok</span>
        ) : null}
        {fmtCost(summary.cost) ? <span className="subagent-head-cost">{fmtCost(summary.cost)}</span> : null}
      </div>

      {error ? <div className="subagent-error">{error}</div> : null}

      {rows.length === 0 ? (
        <div className="subagent-empty">
          这个会话还没有子智能体。
          <br />
          主智能体派子任务（task / subagent）后，这里会实时显示它们在干什么。
        </div>
      ) : (
        <div className="subagent-list">
          {rows.map((row) => (
            <SubagentItem key={row.id} row={row} now={now} onOpen={onOpen} />
          ))}
        </div>
      )}
    </aside>
  )
}

function SubagentItem({ row, now, onOpen }: { row: SubagentRow; now: number; onOpen: (id: string) => void }) {
  const stuck = isStuck(row, now)
  const classes = ['subagent-item', `state-${row.state}`]
  if (stuck) classes.push('stuck')

  return (
    <button type="button" className={classes.join(' ')} onClick={() => onOpen(row.id)} title={`打开 ${row.title}`}>
      <span className="subagent-item-line1">
        <span className={`subagent-mark state-${row.state}`}>{row.mark}</span>
        <span className="subagent-title">{row.title}</span>
      </span>

      <span className="subagent-item-line2">
        <span className="subagent-agent">{row.agent}</span>
        <span className="subagent-sep">·</span>
        <span className="subagent-elapsed">{fmtElapsed(row.elapsedMs)}</span>
        {row.outTokens > 0 ? (
          <>
            <span className="subagent-sep">·</span>
            <span className="subagent-tokens">{fmtTokens(row.outTokens)} tok</span>
          </>
        ) : null}
        {fmtCost(row.cost) ? (
          <>
            <span className="subagent-sep">·</span>
            <span className="subagent-cost">{fmtCost(row.cost)}</span>
          </>
        ) : null}
        {stuck ? <span className="subagent-stuck">卡住？</span> : null}
      </span>

      {row.tool || row.detail ? (
        <span className="subagent-item-line3">
          {row.tool ? <span className="subagent-tool">{row.tool}</span> : null}
          <span className="subagent-detail">{row.detail}</span>
        </span>
      ) : null}
    </button>
  )
}
