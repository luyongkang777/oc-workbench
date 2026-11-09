import { useRef, useState } from 'react'
import {
  ensureTerminalSession,
  readTerminal,
  removeTerminal,
  runInTerminal,
} from '../api/terminal'

type Props = {
  root: string
  connected: boolean
}

type Block = {
  id: number
  cmd: string
  text: string
  done: boolean
  exitCode?: number
}

const POLL_MS = 250
const POLL_LIMIT = 240 // 最长等 60 秒

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export default function Terminal({ root, connected }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [draft, setDraft] = useState('')
  const [running, setRunning] = useState(false)
  const [blocks, setBlocks] = useState<Block[]>([])
  const [error, setError] = useState<string | null>(null)

  const sessionRef = useRef<string | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  function scrollToBottom() {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  async function run() {
    const command = draft.trim()
    if (!command || running || !connected) return

    const id = Date.now()
    setDraft('')
    setError(null)
    setRunning(true)
    setBlocks((prev) => [...prev, { id, cmd: command, text: '', done: false }])

    try {
      const sessionID = sessionRef.current ?? (await ensureTerminalSession(root))
      sessionRef.current = sessionID

      const ptyID = await runInTerminal(sessionID, root, command)
      let lastText = ''
      let finished = false

      for (let i = 0; i < POLL_LIMIT; i += 1) {
        await sleep(POLL_MS)
        const snap = await readTerminal(ptyID)
        if (snap.text !== lastText || snap.status === 'exited') {
          lastText = snap.text
          setBlocks((prev) =>
            prev.map((block) =>
              block.id === id
                ? {
                    ...block,
                    text: snap.text,
                    done: snap.status === 'exited',
                    exitCode: snap.exitCode,
                  }
                : block,
            ),
          )
          scrollToBottom()
        }
        if (snap.status === 'exited') {
          finished = true
          break
        }
      }

      if (!finished) {
        setError('命令超过 60 秒仍在运行，已停止跟踪（命令可能还在后台跑）')
      }
      await removeTerminal(ptyID)
    } catch (err) {
      setError((err as Error).message)
      setBlocks((prev) => prev.map((block) => (block.id === id ? { ...block, done: true } : block)))
    } finally {
      setRunning(false)
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      void run()
    }
  }

  return (
    <section className={`terminal${collapsed ? ' collapsed' : ''}`}>
      <div className="terminal-head">
        <button type="button" className="terminal-toggle" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? '▸' : '▾'} 终端
        </button>
        <span className="terminal-hint">cmd.exe /c，一条一条执行</span>
        <span className="terminal-spacer" />
        <button type="button" className="terminal-clear" onClick={() => setBlocks([])}>
          清空
        </button>
      </div>

      {collapsed ? null : (
        <>
          <div className="terminal-body" ref={bodyRef}>
            {blocks.length === 0 ? (
              <div className="terminal-empty">
                {connected ? '输入命令回车执行，例如 git status' : '等待后端连接…'}
              </div>
            ) : (
              blocks.map((block) => (
                <div className="terminal-block" key={block.id}>
                  <div className="terminal-cmd">&gt; {block.cmd}</div>
                  {block.text ? <pre className="terminal-out">{block.text}</pre> : null}
                  {block.done ? (
                    <div className="terminal-exit">
                      退出码 {block.exitCode ?? '?'}
                    </div>
                  ) : (
                    <div className="terminal-running">运行中…</div>
                  )}
                </div>
              ))
            )}
          </div>

          {error ? <div className="terminal-error">{error}</div> : null}

          <div className="terminal-input-wrap">
            <span className="terminal-prompt">&gt;</span>
            <input
              className="terminal-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={connected ? 'git status' : '后端未连接'}
              disabled={!connected || running}
            />
            <button
              type="button"
              className="terminal-run"
              onClick={() => void run()}
              disabled={!connected || running || draft.trim().length === 0}
            >
              {running ? '运行中' : '执行'}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
