import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ChatHeader from './ChatHeader'
import ChatInput from './ChatInput'
import MessageList from './MessageList'
import QuestionForm from './QuestionForm'
import { copyText } from './clipboard'
import {
  BUILTIN_COMMANDS,
  findCommand,
  mergeCommands,
  parseSlash,
} from './chatCommands'
import { useChatEvents } from '../hooks/useChatEvents'
import { useChatForms } from '../hooks/useChatForms'
import { useChatModels } from '../hooks/useChatModels'
import { useChatRunning } from '../hooks/useChatRunning'
import {
  filesToAttachments,
  planAttachments,
  releaseAttachment,
  MAX_RAW_BYTES,
  type ChatAttachment,
} from './attachments'
import {
  cancelForm,
  compactSession,
  createSession,
  forkSession,
  getSession,
  interruptSession,
  isSessionBusy,
  isWorkbenchSession,
  isWorkbenchTerminal,
  listAgents,
  listCommands,
  listMessages,
  listSessions,
  replyForm,
  runSessionCommand,
  sendPrompt,
  switchAgent,
  type AgentInfo,
  type ChatMessage,
  type CommandInfo,
  type FormInfo,
  type ModelInfo,
  type PromptFile,
  type SessionInfo,
} from '../api/chat'

type Props = {
  root: string
  connected: boolean
  /** 聊天里点文件路径时，用中间栏打开（line 是 1 基行号） */
  onOpenFile: (path: string, line?: number) => void
}

export default function Chat({ root, connected, onOpenFile }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [currentID, setCurrentID] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  // 下拉默认只列工作台会话，这项打开后连外部会话一起列
  const [showAllSessions, setShowAllSessions] = useState(false)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [serverCommands, setServerCommands] = useState<CommandInfo[]>([])

  const currentRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const attachmentsRef = useRef<ChatAttachment[]>([])
  attachmentsRef.current = attachments
  currentRef.current = currentID

  // 切会话时丢掉待发送附件：图是给上一个会话准备的，带过去会发错地方
  useEffect(() => {
    if (!currentID) return
    const pending = attachmentsRef.current
    if (pending.length === 0) return
    pending.forEach(releaseAttachment)
    setAttachments([])
  }, [currentID])

  const modelsApi = useChatModels(root, connected)
  const runningApi = useChatRunning(connected, currentID)
  const formsApi = useChatForms(connected, currentID)
  const reloadForms = formsApi.reload

  // 斜杠命令菜单：agent 列表 + 当前目录的服务端命令（/goal、/swarm…）
  useEffect(() => {
    if (!connected) return
    let alive = true
    void listAgents(root)
      .then((list) => {
        if (alive) setAgents(list)
      })
      .catch(() => {})
    void listCommands(root)
      .then((list) => {
        if (alive) setServerCommands(list)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [connected, root])

  const commands = useMemo(
    () => mergeCommands(BUILTIN_COMMANDS, serverCommands),
    [serverCommands],
  )

  const reloadMessages = useCallback(async (sessionID: string) => {
    try {
      const list = await listMessages(sessionID)
      if (currentRef.current === sessionID) setMessages(list)
    } catch (err) {
      if (currentRef.current === sessionID) setError((err as Error).message)
    }
  }, [])

  // 消息和表单一起刷新：form.created 事件也会推过来
  const refreshSession = useCallback(
    (sessionID: string) => {
      void reloadMessages(sessionID)
      void reloadForms(sessionID)
    },
    [reloadMessages, reloadForms],
  )

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

  useChatEvents(connected, currentID, refreshSession)

  // 新消息到达时贴到底部
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  /** 没有当前会话就先建一个（命令和普通消息共用）。 */
  async function ensureSession(seed: string): Promise<string | null> {
    if (currentRef.current) return currentRef.current
    try {
      const session = await createSession(
        root,
        seed.slice(0, 20) || '工作台会话',
        modelsApi.model ?? undefined,
      )
      setSessions((prev) => [session, ...prev])
      setCurrentID(session.id)
      currentRef.current = session.id
      return session.id
    } catch (err) {
      setError((err as Error).message)
      return null
    }
  }

  /** 工作台内置的斜杠命令。 */
  async function runBuiltin(name: string) {
    if (name === 'new' || name === 'clear') {
      await newSession()
      return
    }
    if (name === 'sessions') {
      setExpanded(true)
      return
    }
    if (name === 'copy') {
      const last = [...messages].reverse().find((message) => message.type === 'assistant')
      const text = (last?.content ?? [])
        .filter((part) => part.type === 'text' && part.text)
        .map((part) => part.text)
        .join('\n\n')
        .trim()
      if (text) await copyText(text)
      return
    }
    if (name === 'fork') {
      if (!currentRef.current) {
        setError('当前没有会话，先发一条消息再分叉')
        return
      }
      setBusy(true)
      setError(null)
      try {
        const forked = await forkSession(currentRef.current)
        setSessions((prev) => [forked, ...prev])
        setCurrentID(forked.id)
        currentRef.current = forked.id
        await reloadMessages(forked.id)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setBusy(false)
      }
      return
    }
    if (name === 'compact') {
      if (!currentRef.current) {
        setError('当前没有会话，先发一条消息再压缩')
        return
      }
      const sessionID = currentRef.current
      setBusy(true)
      setError(null)
      try {
        await compactSession(sessionID)
        runningApi.start(sessionID)
        await reloadMessages(sessionID)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setBusy(false)
      }
      return
    }
    if (name === 'agents') {
      setError('请用斜杠菜单选择 agent：输入 / 后选 agents')
    }
  }

  /** 切换当前会话的 agent。 */
  async function pickAgent(id: string) {
    const sessionID = await ensureSession('切换 agent')
    if (!sessionID) return
    setError(null)
    try {
      await switchAgent(sessionID, id)
      await reloadMessages(sessionID)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  /**
   * 加附件：先压缩/读成 data URL，再按「压缩后的真实体积」过数量与总量规则。
   *
   * 顺序不能反：以前先拿原始 file.size 过 6MB 上限，一张 8MB 截图会被直接拒掉，
   * 而它压成 JPEG 之后通常只有几百 KB。压缩前只挡 32MB 以上的原始文件（避免读爆内存）。
   */
  async function addFiles(files: File[]) {
    if (files.length === 0) return
    const usable: File[] = []
    const tooBig: string[] = []
    for (const file of files) {
      if (file.size > MAX_RAW_BYTES) tooBig.push(`${file.name || '文件'} 超过 32 MB，未读取`)
      else usable.push(file)
    }
    if (usable.length === 0) {
      setError(tooBig.join('；'))
      return
    }

    const { attachments: converted, errors } = await filesToAttachments(usable)
    const plan = planAttachments(
      attachments.map((item) => ({ name: item.name, bytes: item.bytes })),
      converted.map((item) => ({ name: item.name, bytes: item.bytes })),
    )
    const accepted = plan.accept.map((index) => converted[index]).filter(Boolean)
    const rejected = converted.filter((_, index) => !plan.accept.includes(index))
    rejected.forEach(releaseAttachment)
    if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted])

    const messages = [...tooBig, ...errors, plan.notice].filter(Boolean) as string[]
    if (messages.length > 0) setError(messages.join('；'))
  }

  function removeAttachment(id: string) {
    const target = attachments.find((item) => item.id === id)
    if (target) releaseAttachment(target)
    setAttachments((prev) => prev.filter((item) => item.id !== id))
  }

  async function send() {
    const text = draft.trim()
    const files = attachments
    // 生成中不发送：界面上只有「停止」，按 Enter 也不该偷偷追加 steer
    if ((!text && files.length === 0) || busy || runningApi.running) return
    setError(null)

    // 斜杠命令只处理纯文本：带附件时按普通消息发，别把图片丢给 /command
    const parsed = files.length === 0 ? parseSlash(text) : null
    if (parsed) {
      const command = findCommand(commands, parsed.name)
      if (command?.disabled) {
        setError(
          command.note
            ? `/${command.name}：请用${command.note}`
            : `/${command.name} 仅在 TUI 可用`,
        )
        return
      }
      if (command?.builtin) {
        setDraft('')
        await runBuiltin(command.builtin)
        return
      }
      if (command?.group === 'server') {
        const sessionID = await ensureSession(`/${command.name}`)
        if (!sessionID) return
        setDraft('')
        setBusy(true)
        try {
          await runSessionCommand(sessionID, command.name, parsed.args)
          runningApi.start(sessionID)
          await reloadMessages(sessionID)
        } catch (err) {
          setError((err as Error).message)
        } finally {
          setBusy(false)
        }
        return
      }
    }

    const sessionID = await ensureSession(text || files[0]?.name || '图片')
    if (!sessionID) return
    setBusy(true)
    try {
      // 只发 uri：source 里再带一份同样的 data URL 会把请求体翻倍，
      // 外壳 10MB 上限下 4MB 以上的非图片附件必被 413 拒
      const promptFiles: PromptFile[] = files.map((file) => ({
        uri: file.dataUrl,
        name: file.name,
      }))
      await sendPrompt(sessionID, text, promptFiles)
      setDraft('')
      files.forEach(releaseAttachment)
      setAttachments([])
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

  /** 提表单：成功后模型继续跑；失败把错误抛回表单，让它恢复可提交状态。 */
  async function answerForm(form: FormInfo, answer: Record<string, unknown>) {
    setError(null)
    try {
      await replyForm(form.sessionID, form.id, answer)
      await Promise.all([reloadMessages(form.sessionID), reloadForms(form.sessionID)])
      runningApi.start(form.sessionID)
    } catch (err) {
      setError((err as Error).message)
      await reloadForms(form.sessionID)
      throw err
    }
  }

  /** 跳过表单：模型会收到取消原因，不再等。 */
  async function skipForm(form: FormInfo) {
    setError(null)
    try {
      await cancelForm(form.sessionID, form.id, '用户在工作台跳过')
      await Promise.all([reloadMessages(form.sessionID), reloadForms(form.sessionID)])
    } catch (err) {
      setError((err as Error).message)
      await reloadForms(form.sessionID)
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

  /** 选模型 + 思考强度：variant 为空 = 该模型默认档位。 */
  async function pickModelVariant(next: ModelInfo, variant?: string) {
    try {
      const key = await modelsApi.pickVariant(next, currentID, variant)
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
        onPickVariant={(next, variant) => void pickModelVariant(next, variant)}
      />

      {error ? <div className="chat-warn">{error}</div> : null}

      <div className="chat-body" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="chat-placeholder">
            {connected ? '还没有消息，直接在下面输入' : '等待后端连接…'}
          </div>
        ) : (
          <MessageList
            messages={messages}
            running={runningApi.running}
            root={root}
            onOpenFile={onOpenFile}
          />
        )}
      </div>

      {formsApi.forms.length > 0 ? (
        <div className="chat-forms">
          {formsApi.forms.map((form) => (
            <QuestionForm
              key={form.id}
              form={form}
              onSubmit={(answer) => answerForm(form, answer)}
              onSkip={() => void skipForm(form)}
            />
          ))}
        </div>
      ) : null}

      <ChatInput
        draft={draft}
        busy={busy}
        running={runningApi.running}
        connected={connected}
        commands={commands}
        agents={agents}
        attachments={attachments}
        onDraftChange={setDraft}
        onSend={() => void send()}
        onStop={() => void stop()}
        onBuiltin={(name) => void runBuiltin(name)}
        onPickAgent={(id) => void pickAgent(id)}
        onAddFiles={(files) => void addFiles(files)}
        onRemoveAttachment={removeAttachment}
      />
    </div>
  )
}
