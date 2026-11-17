import { useEffect, useRef, useState } from 'react'
import {
  ensureTerminalSession,
  readTerminal,
  removeTerminal,
  runInTerminal,
} from '../api/terminal'

/** 一次性命令块：输入 → 执行 → 轮询输出直到退出。 */

const POLL_MS = 250
const POLL_LIMIT = 240 // 最长等 60 秒

export type Block = {
  id: number
  cmd: string
  text: string
  done: boolean
  exitCode?: number
}

type Alive = { value: boolean }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** 轮询一条命令直到退出或超时。返回 true 表示正常退出，false 表示超时/组件已卸载。 */
async function pollUntilDone(
  ptyID: string,
  alive: Alive,
  onUpdate: (text: string, done: boolean, exitCode?: number) => void,
): Promise<boolean> {
  let lastText = ''
  for (let i = 0; i < POLL_LIMIT; i += 1) {
    await sleep(POLL_MS)
    if (!alive.value) return false
    const snap = await readTerminal(ptyID)
    if (!alive.value) return false
    if (snap.text !== lastText || snap.status === 'exited') {
      lastText = snap.text
      onUpdate(snap.text, snap.status === 'exited', snap.exitCode)
    }
    if (snap.status === 'exited') return true
  }
  return false
}

type Patch = (next: Partial<Block>) => void

/** 跑一条命令并追输出。失败/超时的提示交给调用方决定怎么显示。 */
async function executeCommand(opts: {
  root: string
  command: string
  alive: Alive
  sessionRef: React.MutableRefObject<string | null>
  patch: Patch
  fail: (message: string) => void
}): Promise<void> {
  const { root, command, alive, sessionRef, patch, fail } = opts
  try {
    const sessionID = sessionRef.current ?? (await ensureTerminalSession(root))
    sessionRef.current = sessionID
    const ptyID = await runInTerminal(sessionID, root, command)
    const finished = await pollUntilDone(ptyID, alive, (text, done, exitCode) => {
      patch({ text, done, exitCode })
    })
    if (!finished && alive.value) fail('命令超过 60 秒仍在运行，已停止跟踪（命令可能还在后台跑）')
    await removeTerminal(ptyID)
  } catch (err) {
    if (!alive.value) return
    fail((err as Error).message)
    patch({ done: true })
  }
}

/** 命令块的状态机：发起、轮询、收尾。组件卸载后不再写状态。 */
function useCommandRunner(root: string, connected: boolean) {
  const [draft, setDraft] = useState('')
  const [running, setRunning] = useState(false)
  const [blocks, setBlocks] = useState<Block[]>([])
  const [error, setError] = useState<string | null>(null)

  const sessionRef = useRef<string | null>(null)
  const aliveRef = useRef<Alive>({ value: true })

  useEffect(() => {
    aliveRef.current.value = true
    const alive = aliveRef.current
    return () => {
      alive.value = false
    }
  }, [])

  async function run() {
    const command = draft.trim()
    if (!command || running || !connected) return

    const id = Date.now()
    setDraft('')
    setError(null)
    setRunning(true)
    setBlocks((prev) => [...prev, { id, cmd: command, text: '', done: false }])
    try {
      await executeCommand({
        root,
        command,
        alive: aliveRef.current,
        sessionRef,
        patch: (next) => setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, ...next } : b))),
        fail: setError,
      })
    } finally {
      if (aliveRef.current.value) setRunning(false)
    }
  }

  return { draft, setDraft, running, blocks, error, run, clear: () => setBlocks([]) }
}

function CommandBlock({ block }: { block: Block }) {
  return (
    <div className="terminal-block">
      <div className="terminal-cmd">&gt; {block.cmd}</div>
      {block.text ? <pre className="terminal-out">{block.text}</pre> : null}
      {block.done ? (
        <div className="terminal-exit">退出码 {block.exitCode ?? '?'}</div>
      ) : (
        <div className="terminal-running">运行中…</div>
      )}
    </div>
  )
}

function CommandBody({ blocks, connected, bodyRef }: {
  blocks: Block[]
  connected: boolean
  bodyRef: React.Ref<HTMLDivElement>
}) {
  return (
    <div className="terminal-body" ref={bodyRef}>
      {blocks.length === 0 ? (
        <div className="terminal-empty">
          {connected ? '输入命令回车执行，例如 git status' : '等待后端连接…'}
        </div>
      ) : (
        blocks.map((block) => <CommandBlock key={block.id} block={block} />)
      )}
    </div>
  )
}

function CommandInput({ draft, setDraft, running, connected, onRun }: {
  draft: string
  setDraft: (value: string) => void
  running: boolean
  connected: boolean
  onRun: () => void
}) {
  return (
    <div className="terminal-input-wrap">
      <span className="terminal-prompt">&gt;</span>
      <input
        className="terminal-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onRun()
          }
        }}
        placeholder={connected ? 'git status' : '后端未连接'}
        disabled={!connected || running}
      />
      <button
        type="button"
        className="terminal-run"
        onClick={onRun}
        disabled={!connected || running || draft.trim().length === 0}
      >
        {running ? '运行中' : '执行'}
      </button>
    </div>
  )
}

type Props = {
  root: string
  connected: boolean
}

export default function TerminalCommand({ root, connected }: Props) {
  const { draft, setDraft, running, blocks, error, run, clear } = useCommandRunner(root, connected)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [blocks])

  return (
    <>
      <div className="terminal-bar">
        <span className="terminal-hint">cmd.exe /c，一条一条执行</span>
        <span className="terminal-spacer" />
        <button type="button" className="terminal-clear" onClick={clear}>
          清空
        </button>
      </div>
      <CommandBody blocks={blocks} connected={connected} bodyRef={bodyRef} />
      {error ? <div className="terminal-error">{error}</div> : null}
      <CommandInput
        draft={draft}
        setDraft={setDraft}
        running={running}
        connected={connected}
        onRun={() => void run()}
      />
    </>
  )
}
