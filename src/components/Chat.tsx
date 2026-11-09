import { useCallback, useEffect, useRef, useState } from 'react'
import ChatHeader from './ChatHeader'
import ChatInput from './ChatInput'
import MessageList from './MessageList'
import { useChatEvents } from '../hooks/useChatEvents'
import {
  createSession,
  getDefaultModel,
  getSession,
  interruptSession,
  isSessionBusy,
  listMessages,
  listModels,
  listSessions,
  sendPrompt,
  switchModel,
  type ChatMessage,
  type ModelInfo,
  type SessionInfo,
} from '../api/chat'

type Props = {
  root: string
  connected: boolean
}

type ModelKey = { id: string; providerID: string }


export default function Chat({ root, connected }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [currentID, setCurrentID] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // 回复是否还在生成（后端 busy 时间戳晚于 idle）：决定「发送」显示成「停止」
  const [running, setRunning] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [model, setModel] = useState<ModelKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const currentRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  currentRef.current = currentID

  const reloadMessages = useCallback(async (sessionID: string) => {
    try {
      const list = await listMessages(sessionID)
      if (currentRef.current !== sessionID) return
      setMessages(list)
    } catch (err) {
      if (currentRef.current === sessionID) setError((err as Error).message)
    }
  }, [])


  // 连上（或 root 变化触发重挂载）时拉本目录的会话列表；为空就留空。
  // 不用 booted 守卫：StrictMode 会把 effect 跑两遍，守卫会让第二遍直接跳过、
  // 而第一遍的结果又被 alive 丢弃，导致列表永远为空。
  useEffect(() => {
    if (!connected) return
    let alive = true
    ;(async () => {
      try {
        const list = await listSessions(20, root)
        if (!alive) return
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

  // 模型列表 + 默认模型：连上后拉一次（换目录会重挂载，所以不需要监听 root 之外的变化）
  useEffect(() => {
    if (!connected) return
    let alive = true
    ;(async () => {
      try {
        const list = await listModels(root)
        if (alive) setModels(list)
      } catch {
        // 模型列表拉不到不影响聊天，按钮保持「选择模型」
      }
      // 会话自己没记 model（新建后还没聊过）时，用默认模型兜底显示
      const fallback = await getDefaultModel(root)
      if (!alive || !fallback?.id || !fallback.providerID) return
      setModel((prev) => prev ?? { id: fallback.id, providerID: fallback.providerID })
    })()
    return () => {
      alive = false
    }
  }, [connected, root])

  // 会话切换时同步模型显示（用会话自己的 model 字段）
  useEffect(() => {
    if (!currentID) return
    const session = sessions.find((item) => item.id === currentID)
    const next = session?.model
    if (!next?.id || !next.providerID) return
    setModel((prev) =>
      prev && prev.id === next.id && prev.providerID === next.providerID
        ? prev
        : { id: next.id as string, providerID: next.providerID as string },
    )
  }, [currentID, sessions])

  // 切会话：拉一次历史。
  useEffect(() => {
    if (!currentID) {
      setMessages([])
      setRunning(false)
      return
    }
    void reloadMessages(currentID)
  }, [currentID, reloadMessages])

  useChatEvents(connected, currentID, reloadMessages)

  // 生成中轮询：running 期间每 800ms 查一次会话 busy/idle，结束就复位。
  // 不用「消息列表第一条是 idle」判断——发新消息后旧 idle 还在列表里，会误判。
  useEffect(() => {
    if (!running || !currentID) return
    let alive = true
    const timer = window.setInterval(async () => {
      try {
        const session = await getSession(currentID)
        if (!alive) return
        if (!isSessionBusy(session)) setRunning(false)
      } catch {
        // 单次查询失败忽略，下一轮继续
      }
    }, 800)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [running, currentID])

  // 新消息到达时贴到底部
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
        const session = await createSession(
          root,
          text.slice(0, 20) || '工作台会话',
          model ?? undefined,
        )
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
      setRunning(true)
      await reloadMessages(sessionID)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /** 停止当前回复：调后端 interrupt，成功后刷新消息。 */
  async function stop() {
    if (!currentID || !running) return
    setError(null)
    try {
      const ok = await interruptSession(currentID)
      if (!ok) setError('停止请求没有生效（可能已经结束了）')
      setRunning(false)
      await reloadMessages(currentID)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  /** 选模型：有会话就立刻切；没有会话就只记住，新建会话时带上。 */
  async function pickModel(next: ModelInfo) {
    const key = { id: next.id, providerID: next.providerID }
    setModel(key)
    if (!currentID) return
    try {
      await switchModel(currentID, key)
      setSessions((prev) =>
        prev.map((item) => (item.id === currentID ? { ...item, model: key } : item)),
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function newSession() {
    try {
      const session = await createSession(root, '工作台会话', model ?? undefined)
      setSessions((prev) => [session, ...prev])
      setCurrentID(session.id)
      setExpanded(false)
    } catch (err) {
      setError((err as Error).message)
    }
  }


  const current = sessions.find((session) => session.id === currentID)

  return (
    <div className="chat">
      <ChatHeader
        sessions={sessions}
        current={current}
        expanded={expanded}
        models={models}
        currentModel={model}
        connected={connected}
        onToggleSessions={() => setExpanded((value) => !value)}
        onPickSession={(id) => {
          setCurrentID(id)
          setExpanded(false)
        }}
        onNewSession={() => void newSession()}
        onPickModel={(next) => void pickModel(next)}
      />

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

      <ChatInput
        draft={draft}
        busy={busy}
        running={running}
        connected={connected}
        onDraftChange={setDraft}
        onSend={() => void send()}
        onStop={() => void stop()}
      />
    </div>
  )
}
