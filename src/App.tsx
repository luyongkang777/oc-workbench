import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import ChatPanel from './components/ChatPanel'
import CodeView from './components/CodeView'
import FileTree from './components/FileTree'
import { getAuthState, retryAuth, startAuth, subscribeAuth } from './api/auth'
import { getInfo, readFile, reconnect } from './api/client'

const DEFAULT_ROOT = 'F:\\opencode\\workbench'
const PROBE_INTERVAL_MS = 10_000

export default function App() {
  // 令牌只能经 IPC 拿：ready 之前不发任何 /api 请求，避免先刷一片 401。
  const auth = useSyncExternalStore(subscribeAuth, getAuthState)
  const [connected, setConnected] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [file, setFile] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 每次打开文件的序号：只有最新一次请求的返回才能写进编辑器
  const openSeq = useRef(0)
  // 当前在途的读文件请求：切文件时 aborts 它
  const readAbort = useRef<AbortController | null>(null)
  // 组件是否还在树上：异步回调据此决定要不要写状态
  const alive = useRef(true)
  // 探活请求是否在途：定时探活不叠加；finally 里保证复位
  const probing = useRef(false)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      readAbort.current?.abort()
    }
  }, [])

  // 挂载即发起 IPC 握手；拿不到令牌只影响连接状态，不影响界面渲染。
  useEffect(() => {
    startAuth()
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
    const timer = window.setInterval(probeOnce, PROBE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [auth.status, probeOnce])

  useEffect(
    () => () => {
      // 卸载后到达的 readFile 结果一律丢弃
      openSeq.current += 1
    },
    [],
  )

  async function openFile(relPath: string) {
    const seq = ++openSeq.current
    // 放弃上一个读请求，别让旧响应拖住新文件
    readAbort.current?.abort()
    const controller = new AbortController()
    readAbort.current = controller
    setFile(relPath)
    setLoading(true)
    setError(null)
    try {
      const text = await readFile(DEFAULT_ROOT, relPath, controller.signal)
      if (seq !== openSeq.current) return
      setContent(text)
    } catch (err) {
      if (seq !== openSeq.current) return
      setContent('')
      setError((err as Error).message)
    } finally {
      if (seq === openSeq.current) setLoading(false)
    }
  }

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
      // 外壳版本过旧、没有 /api/reconnect 时忽略，靠下面这次探活定状态
      await reconnect().catch(() => {})
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

      <div className="main">
        <aside className="sidebar">
          <div className="pane-title">资源管理器</div>
          {connected ? (
            // 只在确实连上后端时挂载：否则首屏 /api/fs/list 会先吃 502 并永久停在「加载失败」。
            // 断开时这里换成提示条，组件随之卸载；再次连上就是一个全新实例，会重新拉一次根目录。
            <FileTree root={DEFAULT_ROOT} onOpenFile={openFile} />
          ) : (
            <div className="pane-notice" role="status">
              {auth.status === 'pending' ? '正在连接本地服务…' : '等待后端连接…'}
            </div>
          )}
        </aside>

        <section className="editor-pane">
          <CodeView path={file} content={content} loading={loading} error={error} />
        </section>

        <aside className="chat-pane">
          <ChatPanel connected={connected} />
        </aside>
      </div>
    </div>
  )
}
