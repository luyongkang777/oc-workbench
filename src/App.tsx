import { useEffect, useRef, useState } from 'react'
import ChatPanel from './components/ChatPanel'
import CodeView from './components/CodeView'
import FileTree from './components/FileTree'
import { getInfo, readFile } from './api/client'

const DEFAULT_ROOT = 'F:\\opencode\\workbench'
const PROBE_INTERVAL_MS = 10_000

export default function App() {
  const [connected, setConnected] = useState(false)
  const [file, setFile] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 每次打开文件的序号：只有最新一次请求的返回才能写进编辑器
  const openSeq = useRef(0)

  useEffect(() => {
    let alive = true
    let inflight = false
    const probe = () => {
      // 上一次探活还没回来就不叠加请求，避免后端卡住时请求越堆越多
      if (inflight) return
      inflight = true
      getInfo()
        .then(() => {
          if (alive) setConnected(true)
        })
        .catch(() => {
          if (alive) setConnected(false)
        })
        .finally(() => {
          inflight = false
        })
    }
    probe()
    const timer = window.setInterval(probe, PROBE_INTERVAL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(
    () => () => {
      // 卸载后到达的 readFile 结果一律丢弃
      openSeq.current += 1
    },
    [],
  )

  async function openFile(relPath: string) {
    const seq = ++openSeq.current
    setFile(relPath)
    setLoading(true)
    setError(null)
    try {
      const text = await readFile(DEFAULT_ROOT, relPath)
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

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">OpenCode 工作台</span>
        <span className="topbar-spacer" />
        <span className={`status-dot ${connected ? 'ok' : 'bad'}`} />
        <span className="status-text">{connected ? '已连接' : '未连接'}</span>
      </header>

      <div className="main">
        <aside className="sidebar">
          <div className="pane-title">资源管理器</div>
          <FileTree root={DEFAULT_ROOT} onOpenFile={openFile} />
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
