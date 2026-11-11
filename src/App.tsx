import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import Chat from './components/Chat'
import ReviewPanel from './components/ReviewPanel'
import Terminal from './components/Terminal'
import CodeView from './components/CodeView'
import FileTree from './components/FileTree'
import { getAuthState, onIpcMessage, retryAuth, startAuth, subscribeAuth } from './api/auth'
import { getInfo, reconnect } from './api/client'
import { normalizeRootPath, splitOpenPath } from './components/localPath'
import { CHAT_W, SIDE_W, useUiLayout } from './hooks/useUiLayout'

const DEFAULT_ROOT = 'F:\\opencode\\workbench'
const ROOT_KEY = 'oc-workbench:root'
const PROBE_INTERVAL_MS = 10_000
// 未连上时的快轮询间隔：后端 0.5 秒内就绪时用户感知不到等待。
const FAST_PROBE_INTERVAL_MS = 1_000

export default function App() {
  // 令牌只能经 IPC 拿：ready 之前不发任何 /api 请求，避免先刷一片 401。
  const auth = useSyncExternalStore(subscribeAuth, getAuthState)
  const [connected, setConnected] = useState(false)
  const [view, setView] = useState<'code' | 'diff'>('code')
  const [root, setRoot] = useState(() => {
    try {
      return window.localStorage.getItem(ROOT_KEY) || DEFAULT_ROOT
    } catch {
      // localStorage 被禁用时不能白屏，退回默认目录
      return DEFAULT_ROOT
    }
  })
  const [reconnecting, setReconnecting] = useState(false)
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
      if (alive.current) setConnected(true)
      return true
    } catch {
      if (alive.current) setConnected(false)
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
    const delay = connected ? PROBE_INTERVAL_MS : FAST_PROBE_INTERVAL_MS
    const timer = window.setInterval(probeOnce, delay)
    return () => window.clearInterval(timer)
  }, [auth.status, connected, probeOnce])

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

  const normPath = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()

  function applyRoot(input: string) {
    // 手输/粘贴/外壳下发的路径先抹平：引号、正反斜杠、/c/ 风格、file://、尾斜杠。
    const path = normalizeRootPath(input)
    if (!path) return
    // 同一目录：只补刷新持久化，不清掉正在看的文件（选同一文件夹/重试都会走到这）。
    if (normPath(rootRef.current) === normPath(path)) {
      try {
        window.localStorage.setItem(ROOT_KEY, path)
      } catch {
        // 忽略：仅影响 dev 刷新恢复
      }
      const same = window as unknown as { ipc?: { postMessage(message: string): void } }
      same.ipc?.postMessage(`oc:save-root:${path}`)
      return
    }
    if (editorDirty.current && !window.confirm('当前文件有未保存的修改，切换文件夹会丢弃它，继续？')) {
      return
    }
    rootRef.current = path
    setRoot(path)
    try {
      window.localStorage.setItem(ROOT_KEY, path)
    } catch {
      // 存储不可用只影响 dev 刷新恢复，不影响本次切换
    }
    // exe 外壳把它落到 root.txt（localStorage 按端口分区，跨不了启动）。
    const w = window as unknown as { ipc?: { postMessage(message: string): void } }
    w.ipc?.postMessage(`oc:save-root:${path}`)
    setFile(null)
    setFileRoot(null)
    setFileLine(null)
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
          if (saved) applyRoot(saved)
          return
        }
        if (!message.startsWith('folder:')) return
        const path = message.slice('folder:'.length).trim()
        if (path) applyRoot(path)
      }),
    [],
  )

  // 这里只切换「看哪个文件」；读取、分页、虚拟滚动全部由 CodeView 自己管，
  // 避免每次读到内容都让整个 App（含会话面板）跟着重渲染。
  // 用 useCallback 是为了让聊天里的 Markdown 能靠 memo 跳过重渲染。
  const openFile = useCallback((relPath: string, line?: number, edit?: boolean) => {
    // 编辑中的未保存内容不能因为点了一下文件树就无声丢掉
    if (editorDirty.current && !window.confirm('当前文件有未保存的修改，确定离开？')) return
    // 聊天里的路径常是绝对路径（`C:\...`、`/c/...`），而本地文件通道只收相对 root 的
    // 路径，盘符那一段会被当成非法片段 400 拒掉。落在工作区外就临时换成它所在目录当
    // root —— 只影响编辑器，不改当前工作区，会话和文件树都留在原处。
    const target = splitOpenPath(rootRef.current, relPath)
    if (!target.path) return
    const sameRoot = normPath(target.root) === normPath(rootRef.current)
    setFileRoot(sameRoot ? null : target.root)
    setFile(target.path)
    setFileLine(typeof line === 'number' && Number.isFinite(line) ? line : null)
    setFileSeq((value) => value + 1)
    // 双击文件树：打开后直接进编辑
    if (edit) setAutoEditSeq((value) => value + 1)
    // 停在「审查」面板时点路径/文件树也要有反应：切回代码视图
    setView('code')
  }, [])

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

  const statusOk = auth.status === 'ready' && connected
  const statusText =
    auth.status === 'pending'
      ? '连接中…'
      : auth.status === 'failed'
        ? auth.error
        : connected
          ? '已连接'
          : '未连接'
  const showRetry = !statusOk && auth.status !== 'pending'

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">OpenCode 工作台</span>
        <span className="topbar-spacer" />
        <button
          type="button"
          className={`review-toggle${view === 'diff' ? ' active' : ''}`}
          onClick={() => setView((v) => (v === 'diff' ? 'code' : 'diff'))}
        >
          审查
        </button>
        <span className={`status-dot ${statusOk ? 'ok' : 'bad'}`} />
        <span className="status-text">{statusText}</span>
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
      </header>

      {notice ? <div className="app-notice">{notice.text}</div> : null}

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
              <button type="button" className="pane-action" onClick={pickFolder} title="打开任意文件夹">
                打开
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
            <div className="pane-notice" role="status">
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
          <Chat key={root} root={root} connected={connected} onOpenFile={openFile} />
        </aside>
      </div>

      <Terminal key={root} root={root} connected={connected} />

      {/* 缩放比例：只在 Ctrl+滚轮时短暂出现，平时不占位也不吃鼠标 */}
      <div className={`zoom-hint${scaleHint ? ' show' : ''}`} aria-live="polite">
        {scaleHint ?? ''}
      </div>
    </div>
  )
}
