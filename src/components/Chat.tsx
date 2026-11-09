import { useCallback, useEffect, useRef, useState } from 'react'
import ChatHeader from './ChatHeader'
import ChatInput from './ChatInput'
import MessageList from './MessageList'
import { useChatEvents } from '../hooks/useChatEvents'
import { useChatModels } from '../hooks/useChatModels'
import { useChatRunning } from '../hooks/useChatRunning'
import {
  createSession,
  getSession,
  interruptSession,
  isSessionBusy,
  isWorkbenchSession,
  isWorkbenchTerminal,
  listMessages,
  listSessions,
  sendPrompt,
  type ChatMessage,
  type ModelInfo,
  type SessionInfo,
} from '../api/chat'

type Props = {
  root: string
  connected: boolean
}

export default function Chat({ root, connected }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [currentID, setCurrentID] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  // 下拉默认只列工作台会话，这项打开后连外部会话一起列
  const [showAllSessions, setShowAllSessions] = useState(false)

  const currentRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  currentRef.current = currentID

  const modelsApi = useChatModels(root, connected)
  const runningApi = useChatRunning(connected, currentID)

  const reloadMessages = useCallback(async (sessionID: string) => {
    try {
      const list = await listMessages(sessionID)
      if (currentRef.current === sessionID) setMessages(list)
    } catch (err) {
      if (currentRef.current === sessionID) setError((err as Error).message)
    }
  }, [])

  // 连上（或 root 变化触发重挂载）时拉本目录的会话列表。
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
        // 优先落到工作台自己建的会话上：同目录里 CLI/审核脚本建的会话不该抢默认视图。
        setCurrentID((prev) => {
          if (prev && list.some((s) => s.id === prev)) return prev
          const own = list.find(isWorkbenchSession)
          // 回退时也要跳过终端会话：否则 current 会落到「工作台终端」上，
          // 它既不该出现在下拉里，也不该接收聊天消息。
          return own?.id ?? list.find((item) => !isWorkbenchTerminal(item))?.id ?? null
        })
      } catch (err) {
        if (alive) setError((err as Error).message)
      }
    })()
    return () => {
      alive = false
    }
  }, [connected, root])

  // 会话切换：模型显示跟着会话走（无 model 时用默认模型），并拉一次历史
  const syncSessionModel = modelsApi.syncSession
  useEffect(() => {
    if (!currentID) {
      setMessages([])
      return
    }
    const session = sessions.find((item) => item.id === currentID)
    syncSessionModel(session)
    void reloadMessages(currentID)
  }, [currentID, sessions, syncSessionModel, reloadMessages])

  useChatEvents(connected, currentID, reloadMessages)

  // 新消息到达时贴到底部
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  async function send() {
    const text = draft.trim()
    // 生成中不发送：界面上只有「停止」，按 Enter 也不该偷偷追加 steer
    if (!text || busy || runningApi.running) return
    let sessionID = currentID
    if (!sessionID) {
      try {
        const session = await createSession(
          root,
          text.slice(0, 20) || '工作台会话',
          modelsApi.model ?? undefined,
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
      runningApi.start(sessionID)
      await reloadMessages(sessionID)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /** 停止当前回复：只有后端确认中断才清状态，否则保留「停止」让用户能重试。 */
  async function stop() {
    if (!currentID || !runningApi.running) return
    setError(null)
    try {
      const ok = await interruptSession(currentID)
      if (ok) {
        runningApi.stop()
      } else {
        setError('停止请求没有生效（可能已经结束了）')
        const session = await getSession(currentID)
        if (!isSessionBusy(session)) runningApi.stop()
      }
      await reloadMessages(currentID)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  /** 选模型：同 id+provider 时保留原 variant；成功后同步会话列表里的 model。 */
  async function pickModel(next: ModelInfo) {
    const keep =
      modelsApi.model?.id === next.id && modelsApi.model.providerID === next.providerID
        ? modelsApi.model.variant
        : undefined
    try {
      const key = await modelsApi.pick(next, currentID, keep)
      if (currentID) {
        setSessions((prev) => prev.map((item) => (item.id === currentID ? { ...item, model: key } : item)))
      }
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function newSession() {
    try {
      const session = await createSession(root, '工作台会话', modelsApi.model ?? undefined)
      setSessions((prev) => [session, ...prev])
      setCurrentID(session.id)
      setExpanded(false)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const current = sessions.find((session) => session.id === currentID)
  // 下拉默认只列工作台会话；当前正在看的会话即使是外部会话也保留，
  // 否则顶部标题和高亮会消失。
  const ownSessions = sessions.filter(
    (session) => isWorkbenchSession(session) || session.id === currentID,
  )
  // 终端会话既不是用户会话、也不该被算成「外部会话」：默认视图和计数都跳过它
  const hiddenCount = sessions.filter(
    (session) =>
      !isWorkbenchSession(session) && !isWorkbenchTerminal(session) && session.id !== currentID,
  ).length
  const visibleSessions = showAllSessions
    ? sessions.filter((session) => !isWorkbenchTerminal(session))
    : ownSessions

  return (
    <div className="chat">
      <ChatHeader
        sessions={visibleSessions}
        hiddenCount={hiddenCount}
        showAll={showAllSessions}
        onToggleShowAll={() => setShowAllSessions((value) => !value)}
        current={current}
        expanded={expanded}
        models={modelsApi.models}
        modelsLoading={modelsApi.loading}
        modelsError={modelsApi.error}
        onRetryModels={() => void modelsApi.reload()}
        currentModel={modelsApi.model}
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
        running={runningApi.running}
        connected={connected}
        onDraftChange={setDraft}
        onSend={() => void send()}
        onStop={() => void stop()}
      />
    </div>
  )
}
