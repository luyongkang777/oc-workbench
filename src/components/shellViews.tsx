import type { ShellInfo } from '../api/shells'
import { commandSummary, elapsedOf, statusText } from './shellText'

/** Shell 列表的展示组件（纯渲染，不含请求）。 */

/** 状态标记：跑动转圈；只有退出码 0 才是打勾完成，非 0 打叉。 */
export function ShellMark({ item }: { item: ShellInfo }) {
  if (item.status === 'running') return <span className="shell-dot running spin" />
  if (item.status === 'exited') {
    if (item.exit === 0) return <span className="shell-ok" title="已完成">✓</span>
    // 有 exited 但没退出码（旧服务端 / 被信号结束）：中性圆点，别谎报失败
    if (item.exit == null) return <span className="shell-dot exited" title="已结束（无退出码）" />
    return <span className="shell-fail" title={`退出码 ${item.exit}`}>✗</span>
  }
  return <span className={`shell-dot ${item.status}`} />
}

export function ShellRow({ item, active, now, onPick }: {
  item: ShellInfo
  active: boolean
  now: number
  onPick: (id: string) => void
}) {
  return (
    <button
      type="button"
      data-id={item.id}
      className={`shell-row${active ? ' active' : ''}`}
      onClick={() => onPick(item.id)}
    >
      <ShellMark item={item} />
      <span className="shell-cmd" title={item.command}>{commandSummary(item.command)}</span>
      <span className="shell-meta">{statusText(item.status)} · {elapsedOf(item, now)}</span>
      <span className="shell-pid">pid {item.pid}</span>
    </button>
  )
}

export function ShellRows({ items, selected, onPick }: {
  items: ShellInfo[]
  selected: string | null
  onPick: (id: string) => void
}) {
  const now = Date.now()
  return (
    <div className="shell-list">
      {items.map((item) => (
        <ShellRow key={item.id} item={item} active={item.id === selected} now={now} onPick={onPick} />
      ))}
    </div>
  )
}

export function ShellDetail({ item, output, truncated, error, killing, onKill }: {
  item: ShellInfo
  output: string
  truncated: boolean
  error: string | null
  killing: boolean
  onKill: () => void
}) {
  const placeholder = item.status === 'running' ? '（还没有输出）' : '（没有输出）'
  return (
    <div className="shell-detail">
      <div className="shell-detail-head">
        <span className="shell-detail-title">{statusText(item.status)}</span>
        <span className="shell-detail-exit">
          {item.exit == null ? '' : `退出码 ${item.exit}`}
        </span>
        {truncated ? <span className="shell-detail-cut">输出已截断</span> : null}
        <span className="shell-spacer" />
        <button
          type="button"
          className="shell-kill"
          onClick={onKill}
          disabled={killing || item.status !== 'running'}
        >
          {killing ? '终止中' : '终止'}
        </button>
      </div>
      {error ? <div className="shell-error">{error}</div> : null}
      <pre className="shell-output">{output || placeholder}</pre>
    </div>
  )
}

export function ShellEmpty({ connected, error }: { connected: boolean; error: string | null }) {
  return (
    <div className="shell-empty">
      {error ? <div className="shell-error">{error}</div> : null}
      {connected ? '这个目录下还没有后台命令。模型跑命令时会自动出现在这里。' : '等待后端连接…'}
    </div>
  )
}
