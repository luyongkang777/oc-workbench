/**
 * `/mcps` 的 MCP 列表视图。
 *
 * 列表来自 useMcpServers（和底栏同一份数据），每行带运行时操作：
 *   - failed / needs_auth → 重连（真的再试一次）、断开（停止重试）
 *   - connected / pending → 断开（工具立刻从会话里消失，重启后恢复）
 *   - disabled → 连接
 * 操作只影响当前进程，重启后回到配置里的状态。
 */
import {
  mcpErrorHint,
  mcpStatusText,
  mcpTone,
  sortMcpServers,
  summarizeMcp,
  type McpServerInfo,
} from './mcpStatus'
import { actionsFor } from './manageActions'
import type { McpServersState } from '../hooks/useMcpServers'

type Props = {
  state?: McpServersState
  connected?: boolean
}

function McpRow({ server, state }: { server: McpServerInfo; state: McpServersState }) {
  const tone = mcpTone(server.status)
  const label = server.title?.trim() || server.name
  const error = mcpErrorHint(server.error)
  const busy = state.busy === server.name
  const locked = state.busy !== null

  return (
    <div
      className="manage-row"
      title={server.error ? `${label}\n${server.error}` : `${label}：${mcpStatusText(server.status)}`}
    >
      <span className={`status-dot ${tone}`} aria-hidden="true" />
      <span className="manage-row-main">
        <span className="manage-row-name">{label}</span>
        {error ? <span className="manage-row-desc">{error}</span> : null}
      </span>
      <span className={`manage-row-tag ${tone}`}>{mcpStatusText(server.status)}</span>
      <span className="manage-row-actions">
        {busy ? (
          <span className="manage-mini busy">处理中…</span>
        ) : (
          actionsFor(server.status).map((action) => (
            <button
              key={action.kind}
              type="button"
              className="manage-mini"
              disabled={locked}
              onClick={() => {
                if (action.kind === 'connect') state.connect(server.name)
                else state.disconnect(server.name)
              }}
            >
              {action.label}
            </button>
          ))
        )}
      </span>
    </div>
  )
}

export default function ManageMcpView({ state, connected }: Props) {
  if (!state) return <p className="manage-note">当前没有 MCP 数据源。</p>

  const summary = summarizeMcp(state.servers)
  const list = sortMcpServers(state.servers)
  const broken = list.filter(
    (server) => server.status === 'failed' || server.status === 'needs_auth',
  )
  const reconnecting = state.busy === '*'

  return (
    <>
      <div className="manage-sub manage-sub-actions">
        <span>
          已连接 {summary.connected}/{summary.total}
          {summary.broken > 0 ? ` · ${summary.broken} 个异常` : ''}
          {summary.pending > 0 ? ` · ${summary.pending} 个连接中` : ''}
        </span>
        {broken.length > 0 ? (
          <button
            type="button"
            className="manage-btn ghost"
            disabled={state.busy !== null || connected === false}
            onClick={state.reconnectBroken}
          >
            {reconnecting ? '重连中…' : `全部重连（${broken.length}）`}
          </button>
        ) : null}
      </div>

      {state.error ? <p className="manage-error">{state.error}</p> : null}

      <div className="manage-list">
        {connected === false ? (
          <p className="manage-note">还没连上服务端，连上后再看 MCP 状态。</p>
        ) : list.length === 0 ? (
          <p className="manage-note">{state.loading ? '正在检测…' : '没有配置 MCP 服务器'}</p>
        ) : (
          list.map((server) => <McpRow key={server.name} server={server} state={state} />)
        )}
      </div>

      <div className="manage-foot">
        <span>
          {state.loading
            ? '检测中…'
            : '连接/断开只影响本次运行，重启后恢复配置里的状态'}
        </span>
        <button
          type="button"
          className="manage-btn ghost"
          onClick={state.refresh}
          disabled={state.loading || state.busy !== null || connected === false}
        >
          重新检测
        </button>
      </div>
    </>
  )
}
