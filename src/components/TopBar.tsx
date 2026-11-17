import type { MouseEvent as ReactMouseEvent } from 'react'
import BalanceChip from './BalanceChip'
import { Icon } from './Icon'
import ProjectTabs from './ProjectTabs'
import UpdateEntry from './UpdateEntry'
import WindowControls from './WindowControls'
import type { Project } from './projectList'
import { themeIcon, themeTitle, type ResolvedTheme, type ThemePref } from './theme'

/**
 * 顶栏：品牌、项目标签、主题/账号/Git/审查按钮、连接状态、窗口按钮。
 *
 * 从 App.tsx 抽出来的。它没有自己的状态——所有交互都通过回调回传，
 * 这样 App 仍然是唯一的状态源，顶栏只是「把状态画出来」。
 */
export type TopBarProps = {
  /** 无边框窗口拖动（只有点在非交互元素上才生效） */
  onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void
  projects: Project[]
  activeRoot: string
  runningDirs: Set<string>
  connected: boolean
  onSwitchProject: (path: string) => void
  onRemoveProject: (path: string) => void
  onAddProject: () => void
  themePref: ThemePref
  theme: ResolvedTheme
  onCycleTheme: () => void
  rulesOpen: boolean
  onToggleRules: () => void
  /** 规则覆盖情况的短描述，直接做按钮 title */
  rulesTitle: string
  providerOpen: boolean
  onToggleProvider: () => void
  usageOpen: boolean
  onToggleUsage: () => void
  accountOpen: boolean
  onToggleAccount: () => void
  gitOpen: boolean
  onToggleGit: () => void
  view: 'code' | 'diff'
  onToggleDiff: () => void
  terminalOpen: boolean
  onToggleTerminal: () => void
  statusOk: boolean
  statusText: string
  retryError: string | null
  showRetry: boolean
  reconnecting: boolean
  onRetry: () => void
}

export default function TopBar(props: TopBarProps) {
  return (
    <header className="topbar" onMouseDown={props.onMouseDown}>
      <span className="brand">
        <Icon name="logo" size={16} />
        OpenCode 工作台
      </span>
      <ProjectTabs
        projects={props.projects}
        active={props.activeRoot}
        running={props.runningDirs}
        connected={props.connected}
        onSwitch={props.onSwitchProject}
        onRemove={props.onRemoveProject}
        onAdd={props.onAddProject}
      />
      <div className="topbar-right">
        <UpdateEntry version={__APP_VERSION__} />
        <button
          type="button"
          className={`topbar-iconbtn${props.themePref === 'system' ? ' auto' : ''}`}
          onClick={props.onCycleTheme}
          title={`${themeTitle(props.themePref, props.theme)}（Ctrl+Shift+L）`}
          aria-label="切换主题（跟随系统 / 暗色 / 浅白，Ctrl+Shift+L）"
        >
          <Icon name={themeIcon(props.themePref, props.theme)} size={15} />
        </button>
        <button
          type="button"
          className={`topbar-iconbtn${props.rulesOpen ? ' auto' : ''}`}
          onClick={props.onToggleRules}
          title={props.rulesTitle}
          aria-label="强制规则：全局与当前目录"
        >
          <Icon name="shield" size={15} />
        </button>
        <button
          type="button"
          className={`topbar-iconbtn${props.providerOpen ? ' auto' : ''}`}
          onClick={props.onToggleProvider}
          title="第三方 API 接入：配置模型服务商，自动获取模型"
          aria-label="第三方 API 接入"
        >
          <Icon name="plug" size={15} />
        </button>
        <button
          type="button"
          className={`topbar-iconbtn${props.usageOpen ? ' auto' : ''}`}
          onClick={props.onToggleUsage}
          title="用量：Token、请求、费用与缓存命中率（读 magpie 日志）"
          aria-label="用量"
        >
          <Icon name="gauge" size={15} />
        </button>
        <button
          type="button"
          className={`topbar-iconbtn${props.accountOpen ? ' auto' : ''}`}
          onClick={props.onToggleAccount}
          title="账号：登录后打开同账号下的其他电脑"
          aria-label="账号"
        >
          <Icon name="monitor" size={15} />
        </button>
        <button
          type="button"
          className={`review-toggle${props.gitOpen ? ' active' : ''}`}
          onClick={props.onToggleGit}
          title="仓库状态、提交、推送、回滚、排除"
        >
          Git
        </button>
        <button
          type="button"
          className={`review-toggle${props.view === 'diff' ? ' active' : ''}`}
          onClick={props.onToggleDiff}
        >
          审查
        </button>
        <button
          type="button"
          className={`topbar-iconbtn${props.terminalOpen ? ' auto' : ''}`}
          onClick={props.onToggleTerminal}
          title="终端：显示/隐藏编辑区底部的停靠面板"
          aria-label="终端面板开关"
        >
          <Icon name="terminal" size={15} />
        </button>
        <span className={`status-dot ${props.statusOk ? 'ok' : 'bad'}`} />
        <span className="status-text" title={props.retryError ?? props.statusText}>
          {props.statusText}
        </span>
        <BalanceChip />
        {props.showRetry ? (
          <button
            type="button"
            className="retry-button"
            onClick={props.onRetry}
            disabled={props.reconnecting}
          >
            {props.reconnecting ? '连接中…' : '重试'}
          </button>
        ) : null}
        <WindowControls />
      </div>
    </header>
  )
}
