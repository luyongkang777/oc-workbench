/**
 * `/mcps` 与 `/skills` 的展示面板（外壳）。
 *
 * 两个命令在 TUI 里是「打印一份清单」，工作台没终端回显，所以做成居中弹窗：
 *   mcps  → MCP 服务器与连接状态，带运行时连接/断开/全部重连
 *   skills → 当前目录可见的技能，可展开看 SKILL.md 全文、插入到对话
 *
 * 具体列表拆在 ManageMcpView / ManageSkillView，这里只管壳与关闭语义。
 */
import { useEffect, useRef } from 'react'
import { Icon } from './Icon'
import ManageMcpView from './ManageMcpView'
import ManageSkillView from './ManageSkillView'
import type { McpServersState } from '../hooks/useMcpServers'

export type ManageKind = 'mcps' | 'skills'

type Props = {
  kind: ManageKind
  root?: string
  /** 是否连上了服务端：断开时 MCP 列表是空的，不能提示「没有配置」 */
  connected?: boolean
  /** MCP 数据已有统一的 hook，直接复用，别在面板里再发一套请求 */
  mcp?: McpServersState
  /** 把技能提示词放进输入框（由 Chat 提供） */
  onInsert?: (text: string) => void
  onClose: () => void
}

export default function ManagePanel({
  kind,
  root,
  connected,
  mcp,
  onInsert,
  onClose,
}: Props) {
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
          <ManageMcpView state={mcp} connected={connected} />
        ) : (
          <ManageSkillView root={root} onInsert={onInsert} />
        )}
      </div>
    </div>
  )
}
