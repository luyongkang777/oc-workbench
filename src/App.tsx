import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { onPageVisible, pageVisible } from './api/visibility'
import Chat from './components/Chat'
import ReviewPanel from './components/ReviewPanel'
import Terminal from './components/Terminal'
import GitPanel from './components/GitPanel'
import CodeView from './components/CodeView'
import FileTree from './components/FileTree'
import ProjectTabs from './components/ProjectTabs'
import WelcomePane from './components/WelcomePane'
import UpdateEntry from './components/UpdateEntry'
import { Icon, IconDefs } from './components/Icon'
import WindowControls from './components/WindowControls'
import { isWindowDragTarget, sendWindowCommand } from './api/window'
import { getAuthState, onIpcMessage, retryAuth, startAuth, subscribeAuth } from './api/auth'
import { getInfo, getShellState, reconnect } from './api/client'
import { findLocal, statFile } from './api/localfs'
import { persistProjects, startProjects } from './api/projects'
import {
  findProject,
  normKey,
  parseProjects,
  projectNameOf,
  removeProject,
  setProjectState,
  upsertProject,
} from './components/projectList'
import type { Project } from './components/projectList'
import { normalizeRootPath, splitOpenPath } from './components/localPath'
import {
  nextThemePref,
  parseThemePref,
  resolveTheme,
  themeIcon,
  themeLabel,
  themeTitle,
  type ResolvedTheme,
  type ThemePref,
} from './components/theme'
import { CHAT_W, SIDE_W, useUiLayout } from './hooks/useUiLayout'
import { useSessionLights } from './hooks/useSessionLights'
import ChatTabs from './components/ChatTabs'
import SubagentPanel from './components/SubagentPanel'
import { parseSubagentMode, type SubagentMode } from './components/subagent'
import {
  hiddenRecheckDelay,
  nextReconnectDelay,
  shouldReconnectNow,
} from './components/connectionPolicy'

/** 记在本地：'auto' / 'open' / 'closed'；老值 '1' / '0' 兼容成 open / closed。 */
const SUBAGENT_OPEN_KEY = 'oc-workbench:subagent-open'

/**
 * 没有历史记录时的工作区。
 *
 * 必须留空：以前这里写的是开发机上的一个绝对路径，换台电脑那个目录不存在，
 * 首屏就是一棵报错的空文件树。空字符串表示「还没选项目」，界面走 WelcomePane。
 */
const DEFAULT_ROOT = ''
const ROOT_KEY = 'oc-workbench:root'
const THEME_KEY = 'oc-workbench:theme'
const PROBE_INTERVAL_MS = 10_000
// 未连上时的快轮询间隔：后端 0.5 秒内就绪时用户感知不到等待。
const FAST_PROBE_INTERVAL_MS = 1_000

/** 系统是否深色。matchMedia 不存在（极老内核 / 测试环境）时按暗色处理。 */
function prefersDarkScheme(): boolean {
  if (typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export default function App() {
  // 令牌只能经 IPC 拿：ready 之前不发任何 /api 请求，避免先刷一片 401。
  const auth = useSyncExternalStore(subscribeAuth, getAuthState)
  const [connected, setConnected] = useState(false)
  const [view, setView] = useState<'code' | 'diff'>('code')
  // Git 抽屉是否打开：切项目时由 applyRoot 关掉，避免旧 root 的面板挂在新项目上
  const [gitOpen, setGitOpen] = useState(false)
  /**
   * 子智能体面板三态：
   *   auto   = 有子智能体才展开（默认）。没子智能体时只留一条细条，
   *            不为了一个空列表永久吃掉 320px 编辑器宽度。
   *   open / closed = 用户手动指定的，之后一直按他的来。
   */
  const [subagentMode, setSubagentMode] = useState<SubagentMode>(() => {
    try {
      return parseSubagentMode(window.localStorage.getItem(SUBAGENT_OPEN_KEY))
    } catch {
      return 'auto'
    }
  })
  /** 主聊天栏当前显示哪个会话：子智能体面板只列它的子孙 */
  const [activeSessionID, setActiveSessionID] = useState<string | null>(null)
  /** 会话列表里点 ⧉ 要把某条会话开到标签栏：seq 递增保证同一个 id 也能触发 */
  const [tabRequest, setTabRequest] = useState<{ sessionID: string; seq: number } | null>(null)
  const openInTab = useCallback((sessionID: string) => {
    setTabRequest((prev) => ({ sessionID, seq: (prev?.seq ?? 0) + 1 }))
  }, [])
  const [root, setRoot] = useState(() => {
    try {
      return window.localStorage.getItem(ROOT_KEY) || DEFAULT_ROOT
    } catch {
      // localStorage 被禁用时不能白屏，退回默认目录
      return DEFAULT_ROOT
    }
  })
  // 项目清单：一个目录一个项目，点一下就切过去，每个项目各自记着自己的界面状态
  const [projects, setProjects] = useState<Project[]>([])
  const [reconnecting, setReconnecting] = useState(false)
  // 主题偏好：默认跟随系统。存偏好而不是存结果，系统换色时不用用户再点一次。
  const [themePref, setThemePref] = useState<ThemePref>(() => {
    try {
      return parseThemePref(window.localStorage.getItem(THEME_KEY))
    } catch {
      // localStorage 被禁用时跟随系统
      return 'system'
    }
  })
  // 系统当前是否深色：由 prefers-color-scheme 驱动，切系统主题时实时更新
  const [systemDark, setSystemDark] = useState(() => prefersDarkScheme())
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    setSystemDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  const theme: ResolvedTheme = resolveTheme(themePref, systemDark)
  // 解析后的主题落到 <html data-theme>，CSS 的 :root[data-theme='light'] 据此整体切换。
  // 同时把偏好写进 data-theme-pref，想要「跟随系统」专属样式时可以直接选中。
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.themePref = themePref
    try {
      window.localStorage.setItem(THEME_KEY, themePref)
    } catch {
      // 存储不可用只影响下次启动的恢复，不影响本次
    }
  }, [theme, themePref])
  const [retryError, setRetryError] = useState<string | null>(null)
  const [file, setFile] = useState<string | null>(null)
  // 打开工作区外的文件时，它自己的 root（文件所在目录）；null 表示就在当前工作区里。
  // 分开存是为了点一下聊天里的外部路径不会把整个工作区切走（会话/文件树都还在原处）。
  const [fileRoot, setFileRoot] = useState<string | null>(null)
  // 每次点文件自增：点同一个文件也能强制重读
  const [fileSeq, setFileSeq] = useState(0)
  // 打开时要跳到的行（1 基）；只在本次 openSeq 生效，跳完就不管了
  const [fileLine, setFileLine] = useState<number | null>(null)
  // 双击文件树时自增：CodeView 收到后打开完直接进编辑
  const [autoEditSeq, setAutoEditSeq] = useState(0)
  // 文件树刷新信号：窗口重新获得焦点或点「刷新」时自增
  const [treeSeq, setTreeSeq] = useState(0)
  // 一次性提示（例如打开链接失败），4 秒后自动消失
  const [notice, setNotice] = useState<{ text: string; id: number } | null>(null)
  // 同一句提示连续触发时 id 变化，effect 会重建定时器（否则第二次提示会被旧定时器提前清掉）
  const showNotice = (text: string) => setNotice({ text, id: Date.now() + Math.random() })
  // 键盘监听里要用最新的提示函数；它每次渲染都会重建，用 ref 取，避免每次渲染重挂监听
  const noticeRef = useRef(showNotice)
  noticeRef.current = showNotice

  // Ctrl/⌘ + Shift + L：循环切换主题（跟随系统 → 暗 → 浅），右下角浮层报一下当前状态
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return
      if (event.key.toLowerCase() !== 'l') return
      event.preventDefault()
      const next = nextThemePref(themePref)
      setThemePref(next)
      noticeRef.current(`主题：${themeLabel(next, resolveTheme(next, prefersDarkScheme()))}`)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [themePref])
  // 组件是否还在树上：异步回调据此决定要不要写状态
  const alive = useRef(true)
  // 探活请求是否在途：定时探活不叠加；finally 里保证复位
  const probing = useRef(false)
  // 编辑器里有未保存的改动：切文件 / 切目录前拦一下
  const editorDirty = useRef(false)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

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

      const pane = main.querySelector(which === 'side' ? '.sidebar' : '.chat-pane')
      const base = which === 'side' ? sideW : chatW
      const rendered = pane?.getBoundingClientRect().width ?? base
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

  // 挂载即发起 IPC 握手；拿不到令牌只影响连接状态，不影响界面渲染。
  useEffect(() => {
    startAuth()
  }, [])

  // agent 改完文件后切回来，文件树自动刷新一次。
  useEffect(() => {
    const onFocus = () => setTreeSeq((value) => value + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  /** 立即探活一次（带 15 秒超时），返回是否连上。 */
  const probeNow = useCallback(async (): Promise<boolean> => {
    probing.current = true
    try {
      await getInfo()
      if (alive.current) {
        setConnected(true)
        setRetryError(null)
      }
      return true
    } catch {
      if (alive.current) setConnected(false)
      // 没连上就问外壳「为什么」：换台机器最常见的是 opencode 没装/找不到，
      // 原因直接显示在侧栏，不用用户先点一次「重试」。
      try {
        const state = await getShellState()
        if (alive.current) setRetryError(state.error)
      } catch {
        // 状态接口本身都没通（例如 dev 模式没有外壳）：保留原提示
      }
      return false
    } finally {
      probing.current = false
    }
  }, [])

  /** 定时探活用：上一次还没回来就跳过，避免请求越堆越多。 */
  const probeOnce = useCallback(() => {
    if (probing.current) return
    void probeNow()
  }, [probeNow])

  useEffect(() => {
    if (auth.status !== 'ready') return
    probeOnce()
    // 冷启动时后台还在配对，首次探活经常吃 502。断开态用 1 秒快轮询，
    // 连上后回到 10 秒，保证「启动到可操作」不被 10 秒间隔拖住。
    // 窗口不可见时跳过：最小化后没人看，恢复可见时立刻补一次。
    const delay = connected ? PROBE_INTERVAL_MS : FAST_PROBE_INTERVAL_MS
    const timer = window.setInterval(() => {
      if (pageVisible()) probeOnce()
    }, delay)
    const stopVisible = onPageVisible(probeOnce)
    return () => {
      window.clearInterval(timer)
      stopVisible()
    }
  }, [auth.status, connected, probeOnce])

  /**
   * 断开态自愈：不再等用户点「重试」。
   *
   * 探活失败只说明「此刻连不上」，真正能把状态拨回来的是让外壳重新配一次对
   * （`/api/reconnect` → `opencode service status` + `pair`）。以前这件事只挂在
   * 「重试」按钮上，于是后端晚起、服务重开换了端口、配对 cookie 过期之后，
   * 界面就一直停在「未连接」——「有时候打开一直是未连接」的根就在这。
   *
   * 节奏交给 connectionPolicy：第一次 1.2 秒后（先给外壳自己的 bootstrap 让路），
   * 之后 4s → 8s → 12s → 15s 退避；连上、或者切到后台就立刻停。
   */
  useEffect(() => {
    if (auth.status !== 'ready' || connected) return
    // dev server 没有外壳：Vite 代理盯死一个固定上游，没有「重新配对」这回事，
    // 自动打 /api/reconnect 只会拿 404 把错误条刷出来。dev 里保持手动「重试」原样。
    if (import.meta.env.DEV) return
    let cancelled = false
    let timer = 0
    let attempt = 0

    const step = async () => {
      if (cancelled) return
      // 后台标签页不跑配对：一次性链接会白生成，回到前台再由可见性事件补一次。
      if (!shouldReconnectNow(document.hidden)) {
        timer = window.setTimeout(step, hiddenRecheckDelay())
        return
      }
      attempt += 1
      if (alive.current) setReconnecting(true)
      try {
        await reconnect()
        if (!cancelled) await probeNow()
      } catch (err) {
        // 外壳会回 502 + 具体原因（找不到 opencode、pair 失败等），显示出来别让用户猜。
        if (alive.current) setRetryError((err as Error).message)
      } finally {
        if (alive.current) setReconnecting(false)
      }
      if (cancelled) return
      timer = window.setTimeout(step, nextReconnectDelay(attempt))
    }

    timer = window.setTimeout(step, nextReconnectDelay(0))
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [auth.status, connected, probeNow])

  // 从后台回到前台：立刻补一次探活，别等下一个 1 秒/10 秒周期才亮灯。
  useEffect(() => {
    if (auth.status !== 'ready') return
    const onVisibility = () => {
      if (document.hidden) return
      probeOnce()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [auth.status, probeOnce])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  // 选文件夹：外壳通过 IPC 弹原生对话框；dev/浏览器退化成输入框。
  function pickFolder() {
    const w = window as unknown as { ipc?: { postMessage(message: string): void } }
    if (w.ipc?.postMessage) {
      w.ipc.postMessage('oc:pick-folder')
      return
    }
    const value = window.prompt('输入文件夹路径（可直接粘贴带引号的路径）', root)
    if (value) applyRoot(value)
  }

  // IPC 订阅是空依赖，闭包里的 root 永远是首帧值，所以用 ref 跟踪最新目录。
  const rootRef = useRef(root)
  rootRef.current = root
  // 项目清单同理：IPC 回调里拿不到最新的 state
  const projectsRef = useRef<Project[]>([])
  projectsRef.current = projects
  // 当前界面位置（看哪个文件 / 停在哪个视图），切项目时记到"要离开的"那个项目名下
  const uiStateRef = useRef<{ file: string | null; view: 'code' | 'diff' }>({ file, view })
  uiStateRef.current = { file, view }

  // 路径比较统一用 projectList 的 normKey（去尾分隔符、正反斜杠归一、小写）
  const normPath = normKey

  /** 记住当前目录：root.txt 跨启动，localStorage 只管 dev 刷新。 */
  function rememberRoot(path: string) {
    try {
      window.localStorage.setItem(ROOT_KEY, path)
    } catch {
      // 忽略：仅影响 dev 刷新恢复
    }
    const w = window as unknown as { ipc?: { postMessage(message: string): void } }
    w.ipc?.postMessage(`oc:save-root:${path}`)
  }

  /** 更新清单并立刻落盘（外壳写 projects.json）。 */
  function commitProjects(next: Project[]) {
    projectsRef.current = next
    setProjects(next)
    persistProjects(next)
  }

  /**
   * 切到某个目录：既是「打开文件夹」，也是「切换项目」。
   * 切走时把当前项目的位置记下来，切回来时恢复它自己上次的样子。
   *
   * `persist: false` 用于「启动时恢复上次目录」：只切界面，不把 root.txt 再写一遍。
   * 否则两个窗口各恢复一次就会互相覆盖 root.txt，来回打架。
   */
  function applyRoot(input: string, opts?: { persist?: boolean }) {
    const persist = opts?.persist !== false
    // 手输/粘贴/外壳下发的路径先抹平：引号、正反斜杠、/c/ 风格、file://、尾斜杠。
    const path = normalizeRootPath(input)
    if (!path) return

    // 同一目录：只补刷新持久化，不清掉正在看的文件（选同一文件夹/重试都会走到这）。
    if (normPath(rootRef.current) === normPath(path)) {
      commitProjects(upsertProject(projectsRef.current, path, { lastUsed: Date.now() }))
      if (persist) rememberRoot(path)
      return
    }

    if (editorDirty.current && !window.confirm('当前文件有未保存的修改，切换项目会丢弃它，继续？')) {
      return
    }

    let next = upsertProject(projectsRef.current, path, { lastUsed: Date.now() })
    const leaving = rootRef.current
    if (leaving) next = setProjectState(next, leaving, { ...uiStateRef.current })
    const target = findProject(next, path)
    commitProjects(next)

    rootRef.current = path
    setRoot(path)
    if (persist) rememberRoot(path)

    // 每个项目都是自己的界面：恢复它上次停在哪个文件、哪个视图
    const state = target?.state
    setView(state?.view === 'diff' ? 'diff' : 'code')
    // 换了 root，旧项目的 Git 状态不再适用，面板一并关掉
    setGitOpen(false)
    // 旧项目里点过「开成标签」的请求必须清掉：ChatTabs 是按 root 重挂载的，
    // 留着它会在新项目里自动开出一个指向旧项目会话的标签，还去拉旧历史
    setTabRequest(null)
    setFileRoot(null)
    setFileLine(null)
    setFile(state?.file ?? null)
    setFileSeq((value) => value + 1)
  }

  // 外壳消息：root:<path> 是启动时随令牌下发的上次根目录；
  // folder:<path> 是对话框选完的结果，空路径表示取消。
  useEffect(
    () =>
      onIpcMessage((message) => {
        // 外壳用系统浏览器打开链接失败时回这一条。
        if (message.startsWith('open-url-failed:')) {
          showNotice('用系统浏览器打开链接失败')
          return
        }
        if (message.startsWith('root:')) {
          const saved = message.slice('root:'.length).trim()
          // 启动恢复不算"用户切了项目"，不回写 root.txt：多个窗口同时启动会把 root.txt 拉来拉去
          if (saved) applyRoot(saved, { persist: false })
          return
        }
        if (!message.startsWith('folder:')) return
        const path = message.slice('folder:'.length).trim()
        if (path) applyRoot(path)
      }),
    [],
  )

  // 启动时拉起项目清单。外壳回的清单可能比"刚打开的这个目录"旧（两条 IPC 到达顺序不定），
  // 所以跟本地已有的合并，别把用户刚打开的项目覆盖掉。
  useEffect(() => {
    const stop = startProjects((list) => {
      const merged = parseProjects([...list, ...projectsRef.current])
      const current = rootRef.current
      const hasActive = current && merged.some((p) => normKey(p.path) === normKey(current))
      const withActive =
        current && !hasActive ? parseProjects([...merged, { path: current, name: projectNameOf(current) }]) : merged
      projectsRef.current = withActive
      setProjects(withActive)
      persistProjects(withActive)

      // 没有任何当前项目（首次启动 / 记录被清掉）时，自动打开最近用的那个。
      // 目录已被删掉也照切：文件树会给出明确报错，用户能从首页换一个。
      if (!current && withActive.length > 0) {
        applyRoot(withActive[0].path, { persist: false })
        return
      }
      // 这次启动打开的是哪个项目，就恢复它上次停的位置
      const state = findProject(withActive, current)?.state
      if (!state) return
      if (state.view) setView(state.view)
      if (state.file) {
        setFile(state.file)
        setFileSeq((value) => value + 1)
      }
    })
    return stop
  }, [])

  // 文件/视图变了就把位置写回当前项目。防抖：连点一串文件不会一路写盘。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const current = rootRef.current
      if (!current) return
      const next = setProjectState(projectsRef.current, current, { file, view })
      if (next === projectsRef.current) return
      projectsRef.current = next
      setProjects(next)
      persistProjects(next)
    }, 800)
    return () => window.clearTimeout(timer)
  }, [file, view])

  /** 从列表移除项目：只是不再显示，磁盘上的东西一点不动。 */
  const forgetProject = useCallback((path: string) => {
    const next = removeProject(projectsRef.current, path)
    projectsRef.current = next
    setProjects(next)
    persistProjects(next)
    // 删掉的正好是当前项目：切到清单里第一个，别停在一个已经不在列表里的目录
    if (normKey(path) === normKey(rootRef.current)) {
      const fallback = next[0]
      if (fallback) applyRoot(fallback.path)
    }
    // applyRoot 每次渲染都是新函数，这里只用 ref，所以空依赖是安全的
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 裸文件名定位：聊天里的工具详情常只写 `Status.h`，真实文件往往在 `src\Status.h`。
   * 先看根目录有没有，没有再按名字在工作区里搜；返回命中路径与同名数量。
   */
  const resolveBareName = useCallback(
    async (rootDir: string, name: string): Promise<{ path: string; total: number } | null> => {
      try {
        await statFile(rootDir, name)
        return { path: name, total: 1 }
      } catch {
        // 根目录下没有，退回按文件名搜索
      }
      try {
        const matches = await findLocal(rootDir, name)
        const first = matches[0]
        return first ? { path: first.path, total: matches.length } : null
      } catch {
        return null
      }
    },
    [],
  )

  // 这里只切换「看哪个文件」；读取、分页、虚拟滚动全部由 CodeView 自己管，
  // 避免每次读到内容都让整个 App（含会话面板）跟着重渲染。
  // 用 useCallback 是为了让聊天里的 Markdown 能靠 memo 跳过重渲染。
  const openFile = useCallback(
    (relPath: string, line?: number, edit?: boolean) => {
      // 聊天里的路径常是绝对路径（`C:\...`、`/c/...`），而本地文件通道只收相对 root 的
      // 路径，盘符那一段会被当成非法片段 400 拒掉。落在工作区外就临时换成它所在目录当
      // root —— 只影响编辑器，不改当前工作区，会话和文件树都留在原处。
      const target = splitOpenPath(rootRef.current, relPath)
      if (!target.path) return

      const open = (finalPath: string) => {
        // 编辑中的未保存内容不能因为点了一下文件树就无声丢掉
        if (editorDirty.current && !window.confirm('当前文件有未保存的修改，确定离开？')) return
        const sameRoot = normPath(target.root) === normPath(rootRef.current)
        setFileRoot(sameRoot ? null : target.root)
        setFile(finalPath)
        setFileLine(typeof line === 'number' && Number.isFinite(line) ? line : null)
        setFileSeq((value) => value + 1)
        // 双击文件树：打开后直接进编辑
        if (edit) setAutoEditSeq((value) => value + 1)
        // 停在「审查」面板时点路径/文件树也要有反应：切回代码视图
        setView('code')
      }

      // 裸文件名（不带目录）先定位，别拿它去工作区根上硬拼一个不存在的路径
      if (!/[\\/]/.test(target.path)) {
        void resolveBareName(target.root, target.path).then((hit) => {
          if (!hit) {
            showNotice(`找不到文件：${target.path}`)
            // 顺手刷新文件树：多半是刚被删掉/改名的旧条目
            setTreeSeq((value) => value + 1)
            return
          }
          if (hit.path !== target.path) {
            showNotice(
              hit.total > 1
                ? `已定位到 ${hit.path}（同名 ${hit.total} 个）`
                : `已定位到 ${hit.path}`,
            )
          }
          open(hit.path)
        })
        return
      }

      open(target.path)
    },
    [resolveBareName],
  )

  // 点路径栏的「外部文件」标记：把这个目录正式变成工作区，正在看的文件保持不变。
  const useExternalRoot = useCallback((targetRoot: string) => {
    if (!file) return
    const target = file
    applyRoot(targetRoot)
    // applyRoot 会清掉 file，这里补回来（同一个事件里批处理，最终是新文件）
    setFile(target)
  }, [file, fileRoot])

  // 文件被关掉（删除/切换工作区）时把它的专属 root 一并清掉，
  // 否则下次点工作区内的相对路径还会沿用上一个外部目录。
  useEffect(() => {
    if (!file) setFileRoot(null)
  }, [file])

  const handleEditorDirty = useCallback((dirty: boolean) => {
    editorDirty.current = dirty
  }, [])

  // 文件树删除/重命名前用来判断「当前文件是否有未保存改动」
  const isEditorDirty = useCallback(() => editorDirty.current, [])

  // 保存后文件大小/行数变了，让文件树重拉一次
  const handleEditorSaved = useCallback(() => setTreeSeq((value) => value + 1), [])

  /**
   * 编辑器打不开某个文件：多半是文件树里残留的旧条目（文件已被删/改名）。
   * 提示一句并刷新文件树，旧条目自己就消失了，不用用户手动点「刷新」。
   */
  const handleOpenFailed = useCallback((target: string, message: string) => {
    showNotice(`打不开 ${target}：${message}`)
    setTreeSeq((value) => value + 1)
  }, [])

  /** 文件树里删掉了东西：正在看的是它（或它的子文件）就关掉编辑器。 */
  const handlePathRemoved = useCallback((removed: string) => {
    const target = removed.replace(/[\\/]+$/, '')
    if (!target) return
    setFile((prev) => {
      if (!prev) return prev
      const hit =
        prev === target || prev.startsWith(`${target}\\`) || prev.startsWith(`${target}/`)
      return hit ? null : prev
    })
  }, [])

  /** 重命名：把打开中的文件路径一起换到新名字。 */
  const handlePathRenamed = useCallback((from: string, to: string) => {
    const source = from.replace(/[\\/]+$/, '')
    if (!source) return
    setFile((prev) => {
      if (!prev) return prev
      if (prev === source) return to
      if (prev.startsWith(`${source}\\`) || prev.startsWith(`${source}/`)) {
        return `${to}${prev.slice(source.length)}`
      }
      return prev
    })
  }, [])

  /** 手动重试：没令牌时先重新走 IPC 握手，已有令牌时让外壳重新配对并立刻探活。 */
  async function retryConnect() {
    if (reconnecting) return
    setReconnecting(true)
    try {
      if (auth.status === 'failed') {
        // 令牌都没拿到，直接打 /api/reconnect 必然 403；重新握手，等令牌到了再靠探活定状态
        await retryAuth()
        return
      }
      // 外壳会回 502 + 具体原因（找不到 opencode、pair 失败等），显示出来别让用户猜。
      try {
        await reconnect()
        if (alive.current) setRetryError(null)
      } catch (err) {
        if (alive.current) setRetryError((err as Error).message)
      }
      await probeNow()
    } finally {
      if (alive.current) setReconnecting(false)
    }
  }

  /**
   * 无边框窗口的标题栏拖动。
   *
   * 顶栏空白处按下 → 交给外壳调系统拖动；按在按钮/标签/输入框上则不抢，
   * 否则点「Git」「审查」会变成拖窗口。
   *
   * 双击标题栏要自己处理：我们发的是一次 WM_NCLBUTTONDOWN，系统不会替我们
   * 合成「双击标题栏 = 最大化」。
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

  // 会话状态：一次轮询同时喂顶栏项目灯和会话列表灯，别两套各打一遍
  // 面板模式记到本地：下次打开还保持同样布局
  useEffect(() => {
    try {
      window.localStorage.setItem(SUBAGENT_OPEN_KEY, subagentMode)
    } catch {
      /* 存不进去只影响下次启动的默认值 */
    }
  }, [subagentMode])

  // 会话状态：一次轮询同时喂顶栏项目灯、会话列表灯和标签栏的灯
  const lights = useSessionLights(connected, projects.length)
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

  return (
    <div className="app">
      <IconDefs />
      <header className="topbar" onMouseDown={handleTopbarMouseDown}>
        <span className="brand">
          <Icon name="logo" size={16} />
   OpenCode 工作台
 </span>
        <ProjectTabs
          projects={projects}
          active={root}
          running={lights.dirs}
          connected={connected}
          onSwitch={applyRoot}
          onRemove={forgetProject}
          onAdd={pickFolder}
        />
        <div className="topbar-right">
        <UpdateEntry version={__APP_VERSION__} />
        <button
          type="button"
   className={`topbar-iconbtn${themePref === 'system' ? ' auto' : ''}`}
   onClick={() => setThemePref((cur) => nextThemePref(cur))}
          title={`${themeTitle(themePref, theme)}（Ctrl+Shift+L）`}
   aria-label="切换主题（跟随系统 / 暗色 / 浅白，Ctrl+Shift+L）"
        >
   <Icon name={themeIcon(themePref, theme)} size={15} />
        </button>
        <button
          type="button"
          className={`review-toggle${gitOpen ? ' active' : ''}`}
          onClick={() => setGitOpen((v) => !v)}
          title="仓库状态、提交、推送、回滚、排除"
        >
          Git
        </button>
        <button
          type="button"
          className={`review-toggle${view === 'diff' ? ' active' : ''}`}
          onClick={() => setView((v) => (v === 'diff' ? 'code' : 'diff'))}
        >
          审查
        </button>
        <span className={`status-dot ${statusOk ? 'ok' : 'bad'}`} />
        <span className="status-text" title={retryError ?? statusText}>{statusText}</span>
        {showRetry ? (
          <button
            type="button"
            className="retry-button"
            onClick={() => void retryConnect()}
            disabled={reconnecting}
          >
            {reconnecting ? '连接中…' : '重试'}
          </button>
        ) : null}
        <WindowControls />
        </div>
      </header>

      {notice ? <div className="app-notice">{notice.text}</div> : null}

      {root ? (
      <div
        className="main"
        ref={mainRef}
        style={
          {
            '--side-w': `${sideW}px`,
            '--chat-w': `${chatW}px`,
          } as CSSProperties
        }
      >
        <aside className="sidebar">
          <div className="pane-title">
            资源管理器
            <span className="pane-actions">
              <button
                type="button"
                className="pane-action"
                onClick={() => setTreeSeq((value) => value + 1)}
                title="刷新文件树"
              >
                刷新
              </button>
            </span>
          </div>
          {auth.status === 'ready' ? (
            // 拿到令牌就挂载：文件树走本地直读，不依赖 opencode 连上；
            // 后端断开时只有聊天/审查不可用，文件照样能看。
            <FileTree
              root={root}
              onOpenFile={openFile}
              refreshSeq={treeSeq}
              // 正在看工作区外的文件时不高亮任何树节点（path 是相对文件自己的 root 的）
              activePath={fileRoot ? null : file}
              isDirty={isEditorDirty}
              onPathRemoved={handlePathRemoved}
              onPathRenamed={handlePathRenamed}
            />
          ) : (
            <div className={`pane-notice${retryError ? ' error' : ''}`} role="status">
              {auth.status === 'pending'
                ? '正在连接本地服务…'
                : (retryError ?? '等待后端连接…')}
            </div>
          )}
        </aside>

        <div
          className="col-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          title="拖动调整宽度，双击复位"
          onPointerDown={beginResize('side')}
        />

        <section className="editor-pane">
          {view === 'diff' ? (
            <ReviewPanel root={root} connected={connected} />
          ) : (
            <CodeView
              // 外部文件用它自己的目录当 root，读写/搜索都落在同一个工作目录下
              root={fileRoot ?? root}
              path={file}
              openSeq={fileSeq}
              openLine={fileLine}
              onOpenFile={openFile}
              onDirtyChange={handleEditorDirty}
              onSaved={handleEditorSaved}
              autoEditSeq={autoEditSeq}
              externalRoot={fileRoot}
              onUseExternalRoot={useExternalRoot}
              onOpenFailed={handleOpenFailed}
            />
          )}
        </section>

        <div
          className="col-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整聊天面板宽度"
          title="拖动调整宽度，双击复位"
          onPointerDown={beginResize('chat')}
        />

        <aside className="chat-pane">
          <ChatTabs
            key={root}
            root={root}
            connected={connected}
            onOpenFile={openFile}
            lights={lights.status}
            request={tabRequest}
            onActiveSession={setActiveSessionID}
          />
        </aside>

        <SubagentPanel
          sessionID={activeSessionID ?? undefined}
          connected={connected}
          mode={subagentMode}
          onToggle={(next) => setSubagentMode(next)}
          onOpen={openInTab}
        />
      </div>
      ) : (
        <WelcomePane
          projects={projects}
          connected={connected}
          reason={retryError ?? (auth.status === 'failed' ? auth.error : null)}
          onPick={pickFolder}
          onOpen={(path) => applyRoot(path)}
          onRemove={forgetProject}
        />
      )}

      {root ? <Terminal key={root} root={root} connected={connected} /> : null}

      {root ? (
        <GitPanel
          root={root}
          open={gitOpen}
          onClose={() => setGitOpen(false)}
          onOpenFile={openFile}
        />
      ) : null}

      {/* 缩放比例：只在 Ctrl+滚轮时短暂出现，平时不占位也不吃鼠标 */}
      <div className={`zoom-hint${scaleHint ? ' show' : ''}`} aria-live="polite">
        {scaleHint ?? ''}
      </div>
    </div>
  )
}
