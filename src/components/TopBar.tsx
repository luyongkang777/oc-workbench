import { useState } from 'react'
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
  // 手机上顶栏放不下的入口收进「⋯」抽屉；桌面按钮全部平铺，不显示这个按钮
  const [moreOpen, setMoreOpen] = useState(false)

  return (
    <>
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
          className={`topbar-iconbtn topbar-theme${props.themePref === 'system' ? ' auto' : ''}`}
          onClick={props.onCycleTheme}
          title={`${themeTitle(props.themePref, props.theme)}（Ctrl+Shift+L）`}
          aria-label="切换主题（跟随系统 / 暗色 / 浅白，Ctrl+Shift+L）"
        >
          <Icon name={themeIcon(props.themePref, props.theme)} size={15} />
        </button>
        <button
          type="button"
          className={`topbar-iconbtn topbar-config${props.rulesOpen ? ' auto' : ''}`}
          onClick={props.onToggleRules}
          title={props.rulesTitle}
          aria-label="强制规则：全局与当前目录"
        >
          <Icon name="shield" size={15} />
        </button>
        <button
          type="button"
          className={`topbar-iconbtn topbar-config${props.providerOpen ? ' auto' : ''}`}
          onClick={props.onToggleProvider}
          title="第三方 API 接入：配置模型服务商，自动获取模型"
          aria-label="第三方 API 接入"
        >
          <Icon name="plug" size={15} />
        </button>
        <button
          type="button"
          className={`topbar-iconbtn topbar-usage${props.usageOpen ? ' auto' : ''}`}
          onClick={props.onToggleUsage}
          title="用量：Token、请求、费用与缓存命中率（读 magpie 日志）"
          aria-label="用量"
        >
          <Icon name="gauge" size={15} />
        </button>
        <button
          type="button"
          className={`topbar-iconbtn topbar-config${props.accountOpen ? ' auto' : ''}`}
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
          className={`review-toggle topbar-review${props.view === 'diff' ? ' active' : ''}`}
          onClick={props.onToggleDiff}
        >
          审查
        </button>
        <button
          type="button"
          className={`topbar-iconbtn topbar-terminal${props.terminalOpen ? ' auto' : ''}`}
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
        <button
          type="button"
          className="topbar-iconbtn topbar-more"
          onClick={() => setMoreOpen((v) => !v)}
          aria-label="更多入口：主题、强制规则、第三方 API、账号、用量"
          title="更多：主题 / 强制规则 / 第三方 API / 账号 / 用量"
        >
          ⋯
        </button>
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

      {/* 手机上的「更多」抽屉：桌面这个按钮不渲染，这里的 DOM 也就不会出现 */}
      {moreOpen ? (
        <>
          <div className="topbar-sheet-mask" onClick={() => setMoreOpen(false)} />
          <div className="topbar-sheet" role="dialog" aria-label="更多入口">
            <div className="topbar-sheet-head">更多</div>
            <button
              type="button"
              className="topbar-sheet-item"
              onClick={() => {
                props.onToggleDiff()
                setMoreOpen(false)
              }}
            >
              <Icon name="review" size={17} />
              <span className="topbar-sheet-label">审查视图</span>
              <span className="topbar-sheet-value">{props.view === 'diff' ? '当前是审查' : '当前是代码'}</span>
            </button>
            <button
              type="button"
              className="topbar-sheet-item"
              onClick={() => props.onCycleTheme()}
            >
              <Icon name={themeIcon(props.themePref, props.theme)} size={17} />
              <span className="topbar-sheet-label">主题</span>
              <span className="topbar-sheet-value">
                {props.themePref === 'system' ? '跟随系统' : props.themePref === 'dark' ? '暗色' : '浅白'}
              </span>
            </button>
            <button
              type="button"
              className="topbar-sheet-item"
              onClick={() => {
                props.onToggleTerminal()
                setMoreOpen(false)
              }}
            >
              <Icon name="terminal" size={17} />
              <span className="topbar-sheet-label">终端面板</span>
              <span className="topbar-sheet-value">{props.terminalOpen ? '已打开' : '已收起'}</span>
            </button>
            <button
              type="button"
              className="topbar-sheet-item"
              onClick={() => {
                props.onToggleRules()
                setMoreOpen(false)
              }}
            >
              <Icon name="shield" size={17} />
              <span className="topbar-sheet-label">强制规则</span>
            </button>
            <button
              type="button"
              className="topbar-sheet-item"
              onClick={() => {
                props.onToggleProvider()
                setMoreOpen(false)
              }}
            >
              <Icon name="plug" size={17} />
              <span className="topbar-sheet-label">第三方 API 接入</span>
            </button>
            <button
              type="button"
              className="topbar-sheet-item"
              onClick={() => {
                props.onToggleAccount()
                setMoreOpen(false)
              }}
            >
              <Icon name="monitor" size={17} />
              <span className="topbar-sheet-label">账号与设备</span>
            </button>
            <button
              type="button"
              className="topbar-sheet-item"
              onClick={() => {
                props.onToggleUsage()
                setMoreOpen(false)
              }}
            >
              <Icon name="gauge" size={17} />
              <span className="topbar-sheet-label">用量与花费</span>
            </button>
          </div>
        </>
      ) : null}
    </>
  )
}
