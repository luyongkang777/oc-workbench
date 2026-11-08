import { useEffect, useState } from 'react'
import ChatPanel from './components/ChatPanel'
import CodeView from './components/CodeView'
import FileTree from './components/FileTree'
import { getInfo, readFile } from './api/client'

const DEFAULT_ROOT = 'F:\\opencode\\workbench'

export default function App() {
  const [connected, setConnected] = useState(false)
  const [file, setFile] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getInfo()
      .then(() => alive && setConnected(true))
      .catch(() => alive && setConnected(false))
    return () => {
      alive = false
    }
  }, [])

  async function openFile(relPath: string) {
    setFile(relPath)
    setLoading(true)
    setError(null)
    try {
      setContent(await readFile(DEFAULT_ROOT, relPath))
    } catch (err) {
      setContent('')
      setError((err as Error).message)
    } finally {
      setLoading(false)
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
