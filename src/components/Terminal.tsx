import { useCallback, useEffect, useState } from 'react'
import { listSubagentTree } from '../api/chat'
import { stateOf } from './subagent'
import PtySessions from './PtySessions'
import ShellSessions from './ShellSessions'
import TerminalCommand from './TerminalCommand'

/**
 * 停靠在编辑区底部的终端面板（Cursor 式）。
 *
 * - 开关由父级控制（顶栏按钮 / 头部 ×），这里只负责画
 * - 高度由父级的拖拽逻辑写进 CSS 变量
 * - 头部右侧实时显示「运行中智能体 · 运行中 Shell」数量
 *
 * 三个面板常驻挂载、只用 hidden 切换显隐：切 tab 时草稿、已读输出、
 * 列表缓存都不会丢（卸载就全没了）。隐藏的面板会停止轮询输出，
 * 但 Shell 列表仍按低频刷新——tab 上的数量角标要靠它。
 */

type Tab = 'shell' | 'cmd' | 'pty'

/**
 * 智能体数量的刷新间隔。
 * 子智能体面板自己也拉同一个接口（在跑时 1.2s），这里只是头部一个数字，没必要跟那么快；
 * 两处独立请求是有意的取舍——复用得把面板的数据源提到上层，为一个计数改架构不划算。
 */
const AGENT_POLL_MS = 6000

type Props = {
  root: string
  connected: boolean
  sessionID?: string
  onClose: () => void
}

/** 当前会话下正在跑的子智能体数量。 */
function useSubagentCount(sessionID: string | undefined, connected: boolean): number {
  const [count, setCount] = useState(0)

  useEffect(() => {
    // 换会话先清零：新会话的第一份数据回来前，不要显示上一个会话的数字
    setCount(0)
    if (!sessionID || !connected) return
    let alive = true

    async function refresh() {
      try {
        const nodes = await listSubagentTree(sessionID as string)
        if (!alive) return
        const now = Date.now()
        setCount(nodes.filter((node) => stateOf(node, now) === 'running').length)
      } catch {
        // 网络抖动就保持上一次的数字，不要闪成 0
      }
    }

    void refresh()
    const timer = window.setInterval(refresh, AGENT_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [sessionID, connected])

  return count
}

function TerminalTabBar({ tabs, active, agents, shells, onPick, onClose }: {
  tabs: { id: Tab; label: string }[]
  active: Tab
  agents: number
  shells: number
  onPick: (id: Tab) => void
  onClose: () => void
}) {
  return (
    <div className="terminal-head">
      <div className="terminal-tabs">
        {tabs.map((item) => (
          <button
            type="button"
            key={item.id}
            className={`terminal-tab${active === item.id ? ' active' : ''}`}
            onClick={() => onPick(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <span className="terminal-spacer" />
      <span className="terminal-stats" title="正在运行的数量；打勾才算结束">
        <span className={`terminal-stat${agents > 0 ? ' live' : ''}`} title={`${agents} 个智能体在跑`}>
          {agents}
          <span className="terminal-stat-label"> 智能体</span>
        </span>
        <span className={`terminal-stat${shells > 0 ? ' live' : ''}`} title={`${shells} 条命令在跑`}>
          {shells}
          <span className="terminal-stat-label"> Shell</span>
        </span>
      </span>
      <button type="button" className="terminal-close" onClick={onClose} title="关闭终端" aria-label="关闭终端">
        ×
      </button>
    </div>
  )
}

export default function Terminal({ root, connected, sessionID, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('shell')
  const [shells, setShells] = useState(0)
  const agents = useSubagentCount(sessionID, connected)
  const onCount = useCallback((next: number) => setShells(next), [])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'shell', label: 'Shell' },
    { id: 'cmd', label: '命令' },
    { id: 'pty', label: '终端' },
  ]

  return (
    <section className="terminal docked" data-session={sessionID ?? ''}>
      <TerminalTabBar
        tabs={tabs}
        active={tab}
        agents={agents}
        shells={shells}
        onPick={setTab}
        onClose={onClose}
      />
      <div className="terminal-panes">
        <div className="terminal-pane" hidden={tab !== 'shell'}>
          <ShellSessions root={root} connected={connected} visible={tab === 'shell'} onCount={onCount} />
        </div>
        <div className="terminal-pane" hidden={tab !== 'cmd'}>
          <TerminalCommand root={root} connected={connected} />
        </div>
        <div className="terminal-pane" hidden={tab !== 'pty'}>
          <PtySessions root={root} connected={connected} visible={tab === 'pty'} sessionID={sessionID} />
        </div>
      </div>
    </section>
  )
}
