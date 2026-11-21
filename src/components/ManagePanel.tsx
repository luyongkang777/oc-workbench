/**
 * `/mcps` 与 `/skills` 的展示面板。
 *
 * 这两个命令在 TUI 里是「打印一份清单」，工作台没终端回显，所以做成居中弹窗：
 *   mcps  → 当前目录的 MCP 服务器与连接状态（复用底栏那套清洗/排序）
 *   skills → 当前目录可见的技能（GET /api/skill），带搜索框
 *
 * 数据都能现场刷新，不做常驻轮询：命令是低频、显式的操作。
 */
import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { fetchSkills } from '../api/skills'
import { filterSkills, type SkillInfo } from './skillList'
import {
  mcpErrorHint,
  mcpStatusText,
  mcpTone,
  sortMcpServers,
  summarizeMcp,
} from './mcpStatus'
import type { McpServersState } from '../hooks/useMcpServers'

export type ManageKind = 'mcps' | 'skills'

type Props = {
  kind: ManageKind
  root?: string
  /** 是否连上了服务端：断开时 MCP 列表是空的，不能提示「没有配置」 */
  connected?: boolean
  /** MCP 数据已有统一的 hook，直接复用，别在面板里再发一套请求 */
  mcp?: McpServersState
  onClose: () => void
}

/** MCP 视图：和底栏明细同一份数据、同一套文案。 */
function McpBody({ state, connected }: { state?: McpServersState; connected?: boolean }) {
  if (!state) return <p className="manage-note">当前没有 MCP 数据源。</p>

  const summary = summarizeMcp(state.servers)
  const list = sortMcpServers(state.servers)

  return (
    <>
      <div className="manage-sub">
        已连接 {summary.connected}/{summary.total}
        {summary.broken > 0 ? ` · ${summary.broken} 个异常` : ''}
        {summary.pending > 0 ? ` · ${summary.pending} 个连接中` : ''}
      </div>

      {state.error ? <p className="manage-error">{state.error}</p> : null}

      <div className="manage-list">
        {connected === false ? (
          <p className="manage-note">还没连上服务端，连上后再看 MCP 状态。</p>
        ) : list.length === 0 ? (
          <p className="manage-note">{state.loading ? '正在检测…' : '没有配置 MCP 服务器'}</p>
        ) : (
          list.map((server) => {
            const tone = mcpTone(server.status)
            const label = server.title?.trim() || server.name
            const error = mcpErrorHint(server.error)
            return (
              <div
                key={server.name}
                className="manage-row"
                title={server.error ? `${label}\n${server.error}` : `${label}：${mcpStatusText(server.status)}`}
              >
                <span className={`status-dot ${tone}`} aria-hidden="true" />
                <span className="manage-row-main">
                  <span className="manage-row-name">{label}</span>
                  {error ? <span className="manage-row-desc">{error}</span> : null}
                </span>
                <span className={`manage-row-tag ${tone}`}>{mcpStatusText(server.status)}</span>
              </div>
            )
          })
        )}
      </div>

      <div className="manage-foot">
        <span>{state.loading ? '检测中…' : '状态来自服务端最近一次连接结果'}</span>
        <button
          type="button"
          className="manage-btn ghost"
          onClick={state.refresh}
          disabled={state.loading || connected === false}
        >
          重新检测
        </button>
      </div>
    </>
  )
}

/** 技能视图：拉一次、可搜索、可重拉。 */
function SkillBody({ root }: { root?: string }) {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    // nonce > 0 是用户点了「重新读取」：绕过 60 秒缓存
    fetchSkills(root, { force: nonce > 0 })
      .then((list) => {
        if (!alive) return
        setSkills(list)
      })
      .catch((err) => {
        if (!alive) return
        setSkills([])
        setError((err as Error).message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [root, nonce])

  const shown = filterSkills(skills, query)

  return (
    <>
      <div className="manage-search">
        <Icon name="search" size={14} />
        <input
          className="manage-search-input"
          value={query}
          placeholder="按名字、描述或路径筛选"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="manage-count">
          {loading ? '加载中…' : `${shown.length}/${skills.length}`}
        </span>
      </div>

      {error ? <p className="manage-error">{error}</p> : null}

      <div className="manage-list">
        {loading ? (
          <p className="manage-note">正在读取技能清单…</p>
        ) : shown.length === 0 ? (
          <p className="manage-note">
            {skills.length === 0 ? '当前目录没有可用技能' : '没有匹配的技能'}
          </p>
        ) : (
          shown.map((skill) => (
            <div key={skill.id} className="manage-row" title={skill.path || skill.name}>
              <span className="manage-row-main">
                <span className="manage-row-name">
                  {skill.name}
                  {/* 技能目录名几乎总等于技能名，重复显示只是噪声；不同的才标出来 */}
                  {skill.source && skill.source !== skill.name ? (
                    <span className="manage-row-src">{skill.source}</span>
                  ) : null}
                </span>
                {skill.description ? (
                  <span className="manage-row-desc">{skill.description}</span>
                ) : null}
              </span>
            </div>
          ))
        )}
      </div>

      <div className="manage-foot">
        <span>{loading ? '读取中…' : `共 ${skills.length} 个技能`}</span>
        <button
          type="button"
          className="manage-btn ghost"
          onClick={() => setNonce((value) => value + 1)}
          disabled={loading}
        >
          重新读取
        </button>
      </div>
    </>
  )
}

export default function ManagePanel({ kind, root, connected, mcp, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  // 父组件每次重渲染都会传新的 onClose：放 ref，监听只挂一次
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // Esc 关闭：和底栏浮层保持同一套手感
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 打开就把焦点收进面板：否则输入框还拿着焦点，用户打的字会悄悄进草稿
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  // 打开 MCP 面板就现场查一次：底栏那份可能是启动时的旧状态
  const refreshRef = useRef(mcp?.refresh)
  refreshRef.current = mcp?.refresh
  useEffect(() => {
    if (kind === 'mcps') refreshRef.current?.()
  }, [kind])

  const title = kind === 'mcps' ? 'MCP 服务器' : '技能'
  const icon = kind === 'mcps' ? 'plug' : 'layers'

  return (
    <div className="manage-mask" role="presentation" onMouseDown={onClose}>
      <div
        className="manage-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={dialogRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="manage-head">
          <span className="manage-title">
            <Icon name={icon} size={15} />
            {title}
          </span>
          <button
            type="button"
            className="manage-close"
            aria-label="关闭"
            title="关闭（Esc）"
            onClick={onClose}
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        {kind === 'mcps' ? (
          <McpBody state={mcp} connected={connected} />
        ) : (
          <SkillBody root={root} />
        )}
      </div>
    </div>
  )
}
