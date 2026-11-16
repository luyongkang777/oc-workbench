import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { getAuthState, subscribeAuth } from './api/auth'
import { isWindowDragTarget, sendWindowCommand } from './api/window'
import { AppContext, type AppContextValue } from './appContext'
import AppShell from './components/AppShell'
import FolderPicker from './components/FolderPicker'
import { readRemoteBack } from './appConfig'
import { parseSubagentMode, type SubagentMode } from './components/subagent'
import { useAppEffects } from './hooks/useAppEffects'
import { useConnection } from './hooks/useConnection'
import { useFileTabs } from './hooks/useFileTabs'
import { useMobileLayout } from './hooks/useMobileLayout'
import { useRules } from './hooks/useRules'
import { useSessionLights } from './hooks/useSessionLights'
import { useTheme } from './hooks/useTheme'
import { useUiLayout } from './hooks/useUiLayout'
import { useWorkspace } from './hooks/useWorkspace'

/**
 * 主界面入口：只做两件事 —— 组装状态、把它放进 Context。
 *
 * 具体状态按领域拆在 hooks 里：
 *   useTheme        主题偏好 + 系统深浅色
 *   useConnection   探活 / 断开自愈 / 手动重试
 *   useFileTabs    文件标签、未保存标记、打开/关闭/重命名联动
 *   useWorkspace   项目清单、当前根目录、每个项目的界面位置
 *   useUiLayout    三栏宽度 + Ctrl+滚轮缩放
 *   useMobileLayout手机单列布局与底部导航
 *   useSessionLights 会话灯（顶栏项目灯 + 会话列表灯）
 *   useAppEffects  与领域无关的全局副作用（握手、快捷键、IPC 消息）
 *
 * 渲染在 AppShell 里。这里保持「没有 JSX」，改布局去 AppShell，改状态来这里。
 */
export default function App() {
  // 令牌只能经 IPC 拿：ready 之前不发任何 /api 请求，避免先刷一片 401。
  const auth = useSyncExternalStore(subscribeAuth, getAuthState)
  const { themePref, setThemePref, theme } = useTheme()
  const { connected, reconnecting, retryError, retryConnect } = useConnection(auth.status)

  const [view, setView] = useState<'code' | 'diff'>('code')
  const [gitOpen, setGitOpen] = useState(false)
  const [subagentMode, setSubagentMode] = useState<SubagentMode>(() => {
    try {
      return parseSubagentMode(window.localStorage.getItem('oc-workbench:subagent-open'))
    } catch {
      return 'auto'
    }
  })
  /** 主聊天栏当前显示哪个会话：子智能体面板只列它的子孙 */
  const [activeSessionID, setActiveSessionID] = useState<string | null>(null)
  /** 会话列表里点 ⧉ 要把某条会话开到标签栏：seq 递增保证同一个 id 也能触发 */
  const [tabRequest, setTabRequest] = useState<{ sessionID: string; seq: number } | null>(null)
  const [accountOpen, setAccountOpen] = useState(false)
  /** 强制规则面板（顶栏齿轮）：没有开关，只有两级正文 */
  const [rulesOpen, setRulesOpen] = useState(false)
  /** 第三方 API 接入面板（顶栏插头） */
  const [providerOpen, setProviderOpen] = useState(false)
  // 文件树刷新信号：窗口重新获得焦点或点「刷新」时自增
  const [treeSeq, setTreeSeq] = useState(0)
  // 一次性提示（例如打开链接失败），4 秒后自动消失
  const [notice, setNotice] = useState<{ text: string; id: number } | null>(null)

  const showNotice = useCallback((text: string) => {
    // 同一句提示连续触发时 id 变化，effect 会重建定时器（否则第二次提示会被旧定时器提前清掉）
    setNotice({ text, id: Date.now() + Math.random() })
  }, [])
  const bumpTree = useCallback(() => setTreeSeq((value) => value + 1), [])

  // 窄视口（手机）走单列布局，底部导航切换当前栏
  const { mobile, pane, setPane, showEditor } = useMobileLayout()

  // 打开文件后的界面联动：切回代码视图；手机上还要跳到编辑栏，否则看着像没反应
  const onOpened = useCallback(() => {
    setView('code')
    showEditor()
  }, [showEditor])
  const onViewCode = useCallback(() => setView('code'), [])

  // rootRef 由工作区写、文件标签读（判断文件在不在工作区内）
  const rootRef = useRef('')
  const tabs = useFileTabs({
    rootRef,
    notify: showNotice,
    onOpened,
    onViewCode,
    onTreeStale: bumpTree,
  })

  // 切项目时恢复它的界面：视图、文件标签、旧面板全部换掉
  const onProjectSwitched = useCallback(
    (state?: { file?: string | null; view?: 'code' | 'diff' }) => {
      setView(state?.view === 'diff' ? 'diff' : 'code')
      // 换了 root，旧项目的 Git 状态不再适用，面板一并关掉
      setGitOpen(false)
      // 旧项目里点过「开成标签」的请求必须清掉：ChatTabs 是按 root 重挂载的，
      // 留着它会在新项目里自动开出一个指向旧项目会话的标签，还去拉旧历史
      setTabRequest(null)
      tabs.resetTabs(state?.file ?? null)
    },
    [tabs],
  )

  const {
    root,
    projects,
    applyRoot,
    forgetProject,
    pickFolder,
    folderPickerOpen,
    closeFolderPicker,
    chooseFolder,
  } = useWorkspace({
    rootRef,
    hasDirtyTabs: tabs.hasDirtyTabs,
    currentUiState: () => ({ file: tabs.file, view }),
    onProjectSwitched,
    uiSnapshot: { file: tabs.file, view },
  })

  // 三栏宽度 + 整体缩放（Ctrl/⌘ + 滚轮），都落 localStorage
  const { sideW, chatW, scaleHint, setSideW, setChatW, resetSizes } = useUiLayout()
  const mainRef = useRef<HTMLDivElement | null>(null)

  // 上一次按在分隔条上的时刻。双击复位靠这里判断，不用 dblclick：
  // pointerdown 里的 preventDefault 会掐掉后续的 click，dblclick 就永远不来。
  const lastGrabRef = useRef(0)

  /**
   * 拖动分隔条。
   * 用「实际渲染宽度 / 逻辑宽度」换算鼠标位移，这样界面被 Ctrl+滚轮 zoom 过之后
   * 拖拽手感仍然是 1:1（zoom 会同时改变 clientX 与 getBoundingClientRect 的尺度）。
   */
  const beginResize = useCallback(
    (which: 'side' | 'chat') => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return

      const now = performance.now()
      const isDouble = lastGrabRef.current > 0 && now - lastGrabRef.current < 320
      lastGrabRef.current = isDouble ? 0 : now
      if (isDouble) {
        resetSizes()
        return
      }

      event.preventDefault()
      const main = mainRef.current
      if (!main) return

      const target = main.querySelector(which === 'side' ? '.sidebar' : '.chat-pane')
      const base = which === 'side' ? sideW : chatW
      const rendered = target?.getBoundingClientRect().width ?? base
      const ratio = base > 0 && rendered > 0 ? rendered / base : 1
      const startX = event.clientX

      document.body.classList.add('resizing')

      const onMove = (moveEvent: PointerEvent) => {
        const delta = (moveEvent.clientX - startX) / ratio
        // 左侧分隔条往右拖 = 变宽；右侧分隔条往右拖 = 聊天变窄
        if (which === 'side') setSideW(base + delta)
        else setChatW(base - delta)
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        document.body.classList.remove('resizing')
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [sideW, chatW, setSideW, setChatW, resetSizes],
  )

  useAppEffects({
    bumpTree,
    notice,
    setNotice,
    notify: showNotice,
    themePref,
    setThemePref,
    applyRoot,
    subagentMode,
  })

  // 会话状态：一次轮询同时喂顶栏项目灯、会话列表灯和标签栏的灯
  const lights = useSessionLights(connected, projects.length)

  // 强制规则：目录规则跟当前项目走，切项目会自动重读
  const rules = useRules(root, connected)

  const openInTab = useCallback((sessionID: string) => {
    setTabRequest((prev) => ({ sessionID, seq: (prev?.seq ?? 0) + 1 }))
  }, [])

  // 点路径栏的「外部文件」标记：把这个目录正式变成工作区，正在看的文件保持不变。
  const useExternalRoot = useCallback(
    (targetRoot: string) => {
      const tab = tabs.activeTab
      if (!tab) return
      // applyRoot 可能因为「有未保存文件、用户点了取消」而什么都没做：
      // 这时不能再把标签补开回来，否则会把外部 root 的相对路径当当前工作区打开。
      if (!applyRoot(targetRoot)) return
      tabs.reopenTab(tab)
    },
    [tabs, applyRoot],
  )

  /**
   * 无边框窗口的标题栏拖动。
   * 顶栏空白处按下 → 交给外壳调系统拖动；按在按钮/标签/输入框上则不抢。
   * 双击标题栏要自己处理：我们发的是一次 WM_NCLBUTTONDOWN，系统不会替我们合成最大化。
   */
  function handleTopbarMouseDown(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0) return
    if (!isWindowDragTarget(event.target)) return
    if (event.detail >= 2) {
      sendWindowCommand('toggleMaximize')
      return
    }
    sendWindowCommand('drag')
  }

  // 从远程设备回到本机：exe 点设备时把本机地址作为 back 参数带过去，
  // 设备页 302 到 #t=&back=...（fragment 会保留），这里从 hash 里读一次。
  const [remoteBack] = useState(readRemoteBack)

  const statusOk = auth.status === 'ready' && connected
  const statusText =
    auth.status === 'pending'
      ? '连接中…'
      : auth.status === 'failed'
        ? auth.error
        : connected
          ? '已连接'
          : // 自动重连正在跑：别继续显示死气沉沉的「未连接」，让用户看到它在自愈
            reconnecting
            ? '重连中…'
            : '未连接'
  const showRetry = !statusOk && auth.status !== 'pending'

  const ctx: AppContextValue = {
    auth,
    connected,
    reconnecting,
    retryError,
    retryConnect,
    statusOk,
    statusText,
    showRetry,
    themePref,
    theme,
    setThemePref,
    mobile,
    pane,
    setPane,
    sideW,
    chatW,
    scaleHint,
    beginResize,
    mainRef,
    projects,
    root,
    applyRoot,
    forgetProject,
    pickFolder,
    fileTabs: tabs.fileTabs,
    activeFile: tabs.activeFile,
    file: tabs.file,
    fileRoot: tabs.fileRoot,
    openFile: tabs.openFile,
    selectTab: tabs.selectTab,
    closeTab: tabs.closeTab,
    closeAllTabs: tabs.closeAllTabs,
    isTabDirty: tabs.isTabDirty,
    hasDirtyTabs: tabs.hasDirtyTabs,
    handleTabDirty: tabs.handleTabDirty,
    handleEditorSaved: tabs.handleEditorSaved,
    handleOpenFailed: tabs.handleOpenFailed,
    handlePathRemoved: tabs.handlePathRemoved,
    handlePathRenamed: tabs.handlePathRenamed,
    useExternalRoot,
    view,
    setView,
    gitOpen,
    setGitOpen,
    accountOpen,
    setAccountOpen,
    subagentMode,
    setSubagentMode,
    activeSessionID,
    setActiveSessionID,
    tabRequest,
    openInTab,
    lights,
    rules,
    rulesOpen,
    setRulesOpen,
    providerOpen,
    setProviderOpen,
    notice,
    treeSeq,
    bumpTree,
    handleTopbarMouseDown,
    remoteBack,
  }

  return (
    <AppContext.Provider value={ctx}>
      <AppShell />
      {/* 浏览器/手机选项目目录：exe 里走原生对话框，这里只在外壳缺席时出现 */}
      <FolderPicker
        open={folderPickerOpen}
        initialPath={root}
        onClose={closeFolderPicker}
        onPick={chooseFolder}
      />
    </AppContext.Provider>
  )
}
