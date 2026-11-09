import { useCallback, useEffect, useRef, useState } from 'react'
import MessageList from './MessageList'
import {
  createSession,
  listMessages,
  listSessions,
  sendPrompt,
  subscribeEvents,
  type ChatMessage,
  type MessagePart,
  type SessionInfo,
} from '../api/chat'

type Props = {
  root: string
  connected: boolean
}

const REFRESH_DELAY_MS = 250

function shortTitle(session: SessionInfo): string {
  const title = session.title?.trim()
  if (title) return title
  return session.id.replace(/^ses_/, '').slice(0, 10)
}

function partText(parts: MessagePart[] | undefined): string {
  if (!parts) return ''
  return parts
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('')
}

function toolParts(parts: MessagePart[] | undefined): MessagePart[] {
  if (!parts) return []
  return parts.filter((part) => part.type === 'tool')
}

function formatTime(ms?: number): string {
  if (!ms) return ''
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export default function Chat({ root, connected }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [currentID, setCurrentID] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const currentRef = useRef<string | null>(null)
  const refreshTimer = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  currentRef.current = currentID

  const reloadMessages = useCallback(async (sessionID: string) => {
    try {
      const list = await listMessages(sessionID)
      if (currentRef.current === sessionID) setMessages(list)
    } catch (err) {
      if (currentRef.current === sessionID) setError((err as Error).message)
    }
  }, [])

  /** SSE 事件很多，250ms 合并成一次拉取；不解析具体字段，避免跟事件格式耦合。 */
  const scheduleRefresh = useCallback(
    (sessionID: string) => {
      if (refreshTimer.current !== null) return
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null
        void reloadMessages(sessionID)
      }, REFRESH_DELAY_MS)
    },
    [reloadMessages],
  )

  // 连上（或 root 变化触发重挂载）时拉本目录的会话列表；为空就建一个，省掉用户多点一步。
  // 不用 booted 守卫：StrictMode 会把 effect 跑两遍，守卫会让第二遍直接跳过、
  // 而第一遍的结果又被 alive 丢弃，导致列表永远为空。
  useEffect(() => {
    if (!connected) return
    let alive = true
    ;(async () => {
      try {
        const list = await listSessions(20, root)
        if (!alive) return
        // 不自动建会话：目录没有历史会话时保持空列表，发消息或点「+ 新会话」时再创建，
        // 免得 StrictMode 双跑 / 连接抖动时反复产生空的「工作台会话」。
        setSessions(list)
        // 重连后列表刷新时保留用户正在看的会话，别强行跳到最新一条。
        setCurrentID((prev) => (prev && list.some((s) => s.id === prev) ? prev : (list[0]?.id ?? null)))
      } catch (err) {
        if (alive) setError((err as Error).message)
      }
    })()
    return () => {
      alive = false
    }
  }, [connected, root])

  // 切会话：拉一次历史。
  useEffect(() => {
    if (!currentID) {
      setMessages([])
      return
    }
    void reloadMessages(currentID)
  }, [currentID, reloadMessages])

  // SSE：只处理当前会话的事件。
  useEffect(() => {
    if (!connected) return
    const controller = new AbortController()
    let stopped = false

    ;(async () => {
      while (!stopped) {
        try {
          await subscribeEvents((event) => {
            const sid = event.data?.sessionID
            if (!sid) return
            if (currentRef.current !== sid) return
            scheduleRefresh(sid)
          }, controller.signal)
        } catch {
          if (stopped) return
          await new Promise((resolve) => window.setTimeout(resolve, 2000))
        }
      }
    })()

    return () => {
      stopped = true
      controller.abort()
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current)
        refreshTimer.current = null
      }
    }
  }, [connected, scheduleRefresh])

  // 新消息到达时贴到底部（用户往上翻看历史时不打断，这里简单处理为始终跟随）。
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  async function send() {
    const text = draft.trim()
    if (!text || busy) return
    let sessionID = currentID
    if (!sessionID) {
      try {
        const session = await createSession(root, text.slice(0, 20) || '工作台会话')
        setSessions((prev) => [session, ...prev])
        setCurrentID(session.id)
        sessionID = session.id
        currentRef.current = session.id
      } catch (err) {
        setError((err as Error).message)
        return
      }
    }
    setBusy(true)
    setError(null)
    try {
      await sendPrompt(sessionID, text)
      setDraft('')
      await reloadMessages(sessionID)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  const current = sessions.find((session) => session.id === currentID)

  return (
    <div className="chat">
      <div className="chat-header">
        <button
          type="button"
          className="chat-session-toggle"
          onClick={() => setExpanded((value) => !value)}
          title="切换会话"
        >
          {current ? shortTitle(current) : '会话'} ▾
        </button>
        <button
          type="button"
          className="chat-new"
          onClick={async () => {
            try {
              const session = await createSession(root, '工作台会话')
              setSessions((prev) => [session, ...prev])
              setCurrentID(session.id)
              setExpanded(false)
            } catch (err) {
              setError((err as Error).message)
            }
          }}
        >
          + 新会话
        </button>
      </div>

      {expanded ? (
        <div className="chat-sessions">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`chat-session-item${session.id === currentID ? ' active' : ''}`}
              onClick={() => {
                setCurrentID(session.id)
                setExpanded(false)
              }}
            >
              <span>{shortTitle(session)}</span>
              <span className="chat-session-time">{formatTime(session.time?.updated ?? session.time?.created)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {error ? <div className="chat-warn">{error}</div> : null}

      <div className="chat-body" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="chat-placeholder">
            {connected ? '还没有消息，直接在下面输入' : '等待后端连接…'}
          </div>
        ) : (
          <MessageList messages={messages} />
        )}
      </div>

      <div className="chat-input-wrap">
        <textarea
          className="chat-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={connected ? '输入消息，Enter 发送，Shift+Enter 换行' : '后端未连接'}
          disabled={!connected}
        />
        <button
          type="button"
          className="chat-send"
          onClick={() => void send()}
          disabled={!connected || busy || draft.trim().length === 0}
        >
          {busy ? '发送中' : '发送'}
        </button>
      </div>
    </div>
  )
}
