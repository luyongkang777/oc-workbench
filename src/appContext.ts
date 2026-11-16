import { createContext, useContext } from 'react'
import type { MutableRefObject, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { AuthState } from './api/auth'
import type { FileTab } from './components/fileTabModel'
import type { Project } from './components/projectList'
import type { SubagentMode } from './components/subagent'
import type { ResolvedTheme, ThemePref } from './components/theme'
import type { GatewayDevice } from './api/gateway'
import type { SessionLights } from './hooks/useSessionLights'
import type { RulesController } from './hooks/useRules'
import type { MobilePane } from './hooks/useMobileLayout'

/**
 * 主界面的「状态总线」。
 *
 * 为什么用 Context 而不是继续加 props：三栏布局里每一栏都要读十几个状态，
 * 一路 props 钻透会让 App 和每个子组件都长出 20+ 个参数。Context 只在这里定义一次，
 * 子组件用 `useAppContext()` 各取所需。
 *
 * 注意：这是一个**整体的** value（整对象每次渲染都会新建），所以消费者会跟着重渲染。
 * 目前只有 AppShell 一个消费者，它本来就是全量渲染，代价可接受；
 * 如果以后给某个子树单独优化，再按领域拆成多个 Context。
 */
export type AppContextValue = {
  // 连接 / 认证
  auth: AuthState
  connected: boolean
  reconnecting: boolean
  retryError: string | null
  retryConnect: () => Promise<void>
  statusOk: boolean
  statusText: string
  showRetry: boolean

  // 主题
  themePref: ThemePref
  theme: ResolvedTheme
  setThemePref: (next: ThemePref | ((cur: ThemePref) => ThemePref)) => void

  // 布局
  mobile: boolean
  pane: MobilePane
  setPane: (pane: MobilePane) => void
  sideW: number
  chatW: number
  scaleHint: string | null
  beginResize: (which: 'side' | 'chat') => (event: ReactPointerEvent<HTMLDivElement>) => void
  mainRef: MutableRefObject<HTMLDivElement | null>

  // 工作区
  projects: Project[]
  root: string
  applyRoot: (input: string, opts?: { persist?: boolean }) => void
  forgetProject: (path: string) => void
  pickFolder: () => void

  // 文件标签
  fileTabs: FileTab[]
  activeFile: string | null
  file: string | null
  fileRoot: string | null
  openFile: (relPath: string, line?: number, edit?: boolean) => void
  selectTab: (key: string) => void
  closeTab: (key: string) => void
  closeAllTabs: () => void
  isTabDirty: (key: string) => boolean
  hasDirtyTabs: () => boolean
  handleTabDirty: (key: string, dirty: boolean) => void
  handleEditorSaved: () => void
  handleOpenFailed: (target: string, message: string) => void
  handlePathRemoved: (removed: string) => void
  handlePathRenamed: (from: string, to: string) => void
  useExternalRoot: (targetRoot: string) => void

  // 界面状态
  view: 'code' | 'diff'
  setView: (next: 'code' | 'diff' | ((cur: 'code' | 'diff') => 'code' | 'diff')) => void
  gitOpen: boolean
  setGitOpen: (next: boolean | ((cur: boolean) => boolean)) => void
  accountOpen: boolean
  setAccountOpen: (next: boolean | ((cur: boolean) => boolean)) => void
  subagentMode: SubagentMode
  setSubagentMode: (next: SubagentMode) => void
  activeSessionID: string | null
  setActiveSessionID: (id: string | null) => void
  tabRequest: { sessionID: string; seq: number } | null
  openInTab: (sessionID: string) => void
  lights: SessionLights

  // 强制规则（全局 + 当前目录）：没有开关，只有正文
  rules: RulesController
  rulesOpen: boolean
  setRulesOpen: (next: boolean | ((cur: boolean) => boolean)) => void

  // 第三方 API 接入（provider 面板）
  providerOpen: boolean
  setProviderOpen: (next: boolean | ((cur: boolean) => boolean)) => void

  // 杂项
  notice: { text: string; id: number } | null
  treeSeq: number
  bumpTree: () => void
  handleTopbarMouseDown: (event: ReactMouseEvent<HTMLElement>) => void
  remoteBack: string
  /** 仅供调试：远程设备列表用到时再补 */
  devices?: GatewayDevice[]
}

const Ctx = createContext<AppContextValue | null>(null)

export const AppContext = Ctx

export function useAppContext(): AppContextValue {
  const value = useContext(Ctx)
  if (!value) {
    throw new Error('useAppContext 必须在 <AppContext.Provider> 内使用')
  }
  return value
}
