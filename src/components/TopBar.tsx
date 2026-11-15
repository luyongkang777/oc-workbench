import type { MouseEvent as ReactMouseEvent } from 'react'
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
  accountOpen: boolean
  onToggleAccount: () => void
  gitOpen: boolean
  onToggleGit: () => void
  view: 'code' | 'diff'
  onToggleDiff: () => void
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
        <span className={`status-dot ${props.statusOk ? 'ok' : 'bad'}`} />
        <span className="status-text" title={props.retryError ?? props.statusText}>
          {props.statusText}
        </span>
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
