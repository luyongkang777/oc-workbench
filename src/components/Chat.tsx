import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionLike } from './sessionLight'
import ChatHeader from './ChatHeader'
import ChatInput from './ChatInput'
import CompactLog from './CompactLogPanel'
import MessageList from './MessageList'
import QuestionForm from './QuestionForm'
import { copyText } from './clipboard'
import {
  appendCompactRecord,
  clearCompactLog,
  loadCompactLog,
  type CompactRecord,
} from './compactLog'
import {
  BUILTIN_COMMANDS,
  findCommand,
  mergeCommands,
  parseSlash,
} from './chatCommands'
import { applyStreamEvent } from './streamPatch'
import { computeContextUsage, formatTokens } from './contextUsage'
import { computeSessionStats } from './sessionStats'
import SessionStatsBar from './SessionStatsBar'
import type { StreamEvent } from '../api/chat'
import { useChatEvents } from '../hooks/useChatEvents'
import { useChatForms } from '../hooks/useChatForms'
import { useChatModels } from '../hooks/useChatModels'
import { usePurge } from '../hooks/usePurge'
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
  firstUserText,
  forkSession,
  getSession,
  interruptSession,
  isSessionBusy,
  isWorkbenchSession,
  isWorkbenchTerminal,
  LEGACY_PLACEHOLDER_TITLE,
  listAgents,
  listCommands,
  listMessagePage,
  listMessages,
  listSessions,
  mergeMessages,
  renameSession,
  replyForm,
  runSessionCommand,
  sendPrompt,
  switchAgent,
  titleFromText,
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
  /** 一进来就打开这条会话：标签栏靠它带着指定会话启动 */
  initialSessionID?: string
  /**
   * 没有 initialSessionID 时要不要自动挑一条最近的会话。
   * 默认要（首次进入工作台得有内容）；标签栏里「+ 新标签」那种空槽位传 false，
   * 否则会自动绑到最近那条会话，和已有的标签指向同一个。
   */
  autoPickSession?: boolean
  /** 会话 id → 最新 busy/idle 快照，用来点亮列表和标题上的状态灯 */
  lights?: Map<string, SessionLike>
  /** 把某条会话开进标签栏；不传就不显示「开成标签」入口 */
  onOpenInPanel?: (id: string) => void
  /** 已经开在标签里的会话 id：列表里标灰、按钮禁用 */
  panelIDs?: Set<string>
  /** 当前会话变了（含自动建会话）：主界面靠它知道该列谁的子智能体 */
  onSessionChange?: (sessionID: string | null) => void
  /** 当前会话的信息（哪怕它不在本目录顶层列表里）：标签栏靠它显示标题和灯 */
  onSessionInfo?: (session: SessionInfo) => void
  /**
   * 当前会话是否在生成：子会话不在轮询列表里，标签灯靠这个兜底。
   * `null` = 不知道（Chat 即将卸载，比如用户切到别的标签）——标签据此显示灰灯，
   * 而不是继续亮着上一次的黄灯。
   */
  onSessionRunning?: (sessionID: string, running: boolean | null) => void
}

/**
 * 聊天区的状态提示条。
 *
 * 压缩上下文要跑几十秒到几分钟、还会把整段历史重写掉，这两个事实
 * 以前完全没出现在界面上：点了按钮只看到浮层里三个点，压缩完了
 * 聊天内容突然变了也没人告诉你。所以压缩的开始、结果、失败都走这条提示。
 */
type ChatNotice = {
  tone: 'info' | 'ok' | 'fail'
  text: string
  detail?: string
}

/** 首次进入会话先拉几页（每页 200 条），剩下的往上滚时续拉。 */
const INITIAL_MESSAGE_PAGES = 5

/**
 * 标题是服务端在第一条消息之后才生成的（实测十几到二十几秒）。
 * 刚建的会话先显示「新会话」，这段时间里隔几秒问一次，拿到就换上。
 */
const TITLE_POLL_INTERVAL = 5_000
const TITLE_POLL_TRIES = 18
/** 一次加载最多给几条历史会话补名字：每个都要翻消息，别在首屏一次开一堆请求。 */
const TITLE_BACKFILL_LIMIT = 6

export default function Chat({
  root,
  connected,
  onOpenFile,
  initialSessionID,
  autoPickSession = true,
  lights,
  onOpenInPanel,
  panelIDs,
  onSessionChange,
  onSessionInfo,
  onSessionRunning,
}: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [currentID, setCurrentID] = useState<string | null>(initialSessionID ?? null)
  /**
   * 子会话（子智能体）不在顶层会话列表里，按 id 补查到的信息放这里。
   * 顶部标题和标签栏都靠它，否则点进子智能体会显示成「会话 / 新会话」。
   */
  const [extraSession, setExtraSession] = useState<SessionInfo | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  // 下拉默认只列工作台会话，这项打开后连外部会话一起列
  const [showAllSessions, setShowAllSessions] = useState(false)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  // 当前会话的 agent（界面叫「模式」）。空串表示跟着服务端默认走，显示时回退到第一个。
  const [agent, setAgent] = useState('')
  const [serverCommands, setServerCommands] = useState<CommandInfo[]>([])
  // 历史分页：还有更早的没拉 / 正在拉 / 压缩中
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [compacting, setCompacting] = useState(false)
  // 聊天区顶部的状态提示（压缩开始/完成/失败）。压缩结束后保留，直到用户关掉或发下一条消息。
  const [notice, setNotice] = useState<ChatNotice | null>(null)
  // 本会话历次压缩（本地留存）：压缩重写历史后，这是唯一能回看「压过几次」的东西
  const [compactLog, setCompactLog] = useState<CompactRecord[]>([])

  const currentRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const attachmentsRef = useRef<ChatAttachment[]>([])
  /** 继续往更早翻的游标；空 = 已经拉到最早 */
  const olderCursorRef = useRef<string | undefined>(undefined)
  /** 会话列表的最新快照：定时器里读它，避免闭包拿到旧 state */
  const sessionsRef = useRef<SessionInfo[]>([])
  attachmentsRef.current = attachments
  currentRef.current = currentID
  sessionsRef.current = sessions
  // 上报当前会话：主界面的子智能体面板靠它知道该列谁的子孙。
  // 回调每次渲染都可能是新函数，不进依赖，只在会话 id 变化时通知。
  useEffect(() => {
    onSessionChange?.(currentID)
  }, [currentID])

  // 是否「贴着底部」。用户往上翻看历史后，任何一次刷新（会话重拉、流式追加）
  // 都不能把他拽回底部；只有本来就贴底时才跟随新内容。
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  // 切会话时丢掉待发送附件：图是给上一个会话准备的，带过去会发错地方
  useEffect(() => {
    if (!currentID) return
    const pending = attachmentsRef.current
    if (pending.length === 0) return
    pending.forEach(releaseAttachment)
    setAttachments([])
  }, [currentID])

  const modelsApi = useChatModels(root, connected)
  const purgeApi = usePurge(connected)
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

  /**
   * 流式事件队列：一帧合并一次 setMessages。
   *
   * 模型的 delta 频率远高于屏幕刷新率，逐条 setState 等于把同样的渲染
   * 重复做几十遍 —— 这是流式时主线程被占满、滚动掉帧的主要来源。
   *
   * 必须定义在 reloadMessages 之前：全量对账前先把队列落地，否则服务端
   * 快照会先覆盖、随后积压的 delta 又追加一遍，文字就重复了。
   */
  const streamQueue = useRef<StreamEvent[]>([])
  const streamFrame = useRef<number | null>(null)

  const flushStream = useCallback(() => {
    streamFrame.current = null
    const batch = streamQueue.current
    if (batch.length === 0) return
    streamQueue.current = []
    setMessages((prev) => {
      let next = prev
      for (const event of batch) next = applyStreamEvent(next, event)
      return next
    })
  }, [])

  /**
   * 增量刷新：只拉最新一页，和本地已有历史合并。
   *
   * 事件流里每个非增量事件都会触发一次刷新。这里如果整包覆盖，
   * 长会话的历史会被服务端默认的「最新 50 条」顶掉——这正是
   * 「聊多了之前的记录就没了」的直接原因。
   */
  const reloadMessages = useCallback(async (sessionID: string) => {
    try {
      const page = await listMessagePage(sessionID)
      if (currentRef.current !== sessionID) return
      setMessages((prev) => mergeMessages(prev, page.messages))
      // 游标只记一次：用户已经翻到的位置不能被后续刷新覆盖
      if (!olderCursorRef.current && page.next) {
        olderCursorRef.current = page.next
        setHasOlder(true)
      }
    } catch (err) {
      if (currentRef.current === sessionID) setError((err as Error).message)
    }
  }, [])

  /**
   * 切会话（或首次进入）：先拉最近几页，剩下的留给往上滚时续拉。
   *
   * 单次请求只给 50 条，不翻页就只能看到最近一小段；但一次全拉又会让
   * 超大会话卡住首屏，所以这里先取 5 页（1000 条），到底了就没有「更早」。
   */
  const loadSession = useCallback(async (sessionID: string): Promise<ChatMessage[] | null> => {
    olderCursorRef.current = undefined
    try {
      const { messages: all, hasMore, next } = await listMessages(sessionID, INITIAL_MESSAGE_PAGES)
      // 会话已经切走了：不要用旧会话的消息覆盖界面，但要如实告诉调用方没拿到
      if (currentRef.current !== sessionID) return null
      setMessages(all)
      olderCursorRef.current = next
      setHasOlder(hasMore)
      return all
    } catch (err) {
      if (currentRef.current === sessionID) setError((err as Error).message)
      return null
    }
  }, [])

  // 消息和表单一起刷新：form.created 事件也会推过来。
  // 必须返回 Promise，useChatEvents 的串行闸要等它真的拉完才放行下一次。
  const refreshSession = useCallback(
    async (sessionID: string) => {
      // 先把攒在帧里的 delta 落地，全量对账再基于最新本地内容合并
      flushStream()
      await Promise.all([reloadMessages(sessionID), reloadForms(sessionID)])
    },
    [flushStream, reloadMessages, reloadForms],
  )

  /** 把新标题写回列表：顶部标题和下拉都从这份 state 读。 */
  const applyTitle = useCallback((sessionID: string, title: string) => {
    setSessions((prev) =>
      prev.map((item) => (item.id === sessionID && item.title !== title ? { ...item, title } : item)),
    )
  }, [])

  /**
   * 兜底起名：服务端迟迟不给标题时（首条消息报错、起名任务失败），
   * 用首条用户消息压一行写回服务端。返回算出来的标题，空 = 没有可用消息。
   */
  const deriveTitle = useCallback(async (sessionID: string): Promise<string> => {
    const title = titleFromText(await firstUserText(sessionID))
    if (!title) return ''
    await renameSession(sessionID, title)
    return title
  }, [])

  const titleTimers = useRef(new Map<string, number>())

  /**
   * 等标题。会话刚建时没有标题，服务端在第一条消息之后才生成摘要标题；
   * 前端拿不到推送，只能隔几秒问一次会话本身。拿到就换上，问不到就走兜底。
   */
  const watchTitle = useCallback(
    (sessionID: string) => {
      if (titleTimers.current.has(sessionID)) return
      let tries = 0
      let timer = 0
      const finish = () => {
        window.clearInterval(timer)
        titleTimers.current.delete(sessionID)
      }
      const tick = async () => {
        tries += 1
        try {
          const session = await getSession(sessionID)
          const title = session.title?.trim()
          if (title) {
            applyTitle(sessionID, title)
            finish()
            return
          }
        } catch {
          // 单次请求失败不算结束：下一拍再问
        }
        if (tries >= TITLE_POLL_TRIES) {
          finish()
          void deriveTitle(sessionID)
            .then((title) => {
              if (title) applyTitle(sessionID, title)
            })
            .catch(() => {})
        }
      }
      timer = window.setInterval(() => void tick(), TITLE_POLL_INTERVAL)
      titleTimers.current.set(sessionID, timer)
    },
    [applyTitle, deriveTitle],
  )

  // 卸载时把还在等的定时器清掉，别让它们在页面关掉后继续跑
  useEffect(
    () => () => {
      titleTimers.current.forEach((timer) => window.clearInterval(timer))
      titleTimers.current.clear()
    },
    [],
  )

  /**
   * 历史会话补名字。老版本建会话时把「工作台会话」写死成标题，
   * 服务端因此不会自动取名。这里只认工作台自己建的、标题仍是占位符的会话，
   * 用首条用户消息压一行写回；点了 + 新会话却没发言的保持原样。
   */
  const backfillTitles = useCallback(
    async (list: SessionInfo[]) => {
      const targets = list
        .filter(
          (item) => isWorkbenchSession(item) && item.title?.trim() === LEGACY_PLACEHOLDER_TITLE,
        )
        .slice(0, TITLE_BACKFILL_LIMIT)
      const renamed: Record<string, string> = {}
      for (const session of targets) {
        try {
          const title = await deriveTitle(session.id)
          if (title) renamed[session.id] = title
        } catch {
          // 补名字是锦上添花：单个失败不影响列表
        }
      }
      // 一次提交：会话列表一变就会重拉当前会话的历史，逐条提交等于重拉好几遍
      if (Object.keys(renamed).length === 0) return
      setSessions((prev) =>
        prev.map((item) => (renamed[item.id] ? { ...item, title: renamed[item.id] } : item)),
      )
    },
    [deriveTitle],
  )

  /**
   * 流式增量：文本事件直接改本地那条消息，不重新拉整包。
   * 大会话一次全量 6MB+，原来每个 delta 都拉一遍，越聊越卡。
   */
  const applyStream = useCallback(
    (event: StreamEvent) => {
      streamQueue.current.push(event)
      if (streamFrame.current !== null) return
      streamFrame.current = window.requestAnimationFrame(flushStream)
    },
    [flushStream],
  )

  // 卸载时丢掉还没落地的积压，别在页面已经切走后还写一次 state
  useEffect(
    () => () => {
      if (streamFrame.current !== null) window.cancelAnimationFrame(streamFrame.current)
      streamFrame.current = null
      streamQueue.current = []
    },
    [],
  )

  // 连上（或 root 变化触发重挂载）时拉本目录的会话列表。
  // 不用 booted 守卫：StrictMode 会把 effect 跑两遍，守卫会让第二遍直接跳过、
  // 而第一遍的结果又被 alive 丢弃，导致列表永远为空。
  //
  // initialSessionID 有值 = 这是并排面板：只补自己那条会话的名字。
  // 几列同时开时一起跑补名字会对同一条会话发好几遍改名请求。
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
          // 标签栏的「+ 新标签」是一个空槽位：不要自动挑一条最近的会话塞进去，
          // 否则会和已有标签指向同一条，看着像两个标签是同一份历史
          if (!autoPickSession) return prev
          const own = list.find(isWorkbenchSession)
          // 回退时也要跳过终端会话：否则 current 会落到「工作台终端」上，
          // 它既不该出现在下拉里，也不该接收聊天消息。
          return own?.id ?? list.find((item) => !isWorkbenchTerminal(item))?.id ?? null
        })
        // 老数据补名字：标题还是占位符的那些，用首条消息改写（后台跑，不挡列表）
        void backfillTitles(initialSessionID ? list.filter((s) => s.id === initialSessionID) : list)
      } catch (err) {
        if (alive) setError((err as Error).message)
      }
    })()
    return () => {
      alive = false
    }
  }, [connected, root, backfillTitles, initialSessionID, autoPickSession])

  // 会话切换：拉一次历史。
  //
  // 只认 currentID 和 connected：会话列表会随轮询不断换引用（灯要跟着亮），
  // 把它放进依赖会让历史每 1.5 秒重拉一遍。但断线期间漏掉的消息必须在
  // 重连后补回来，所以 connected 变 true 时也重拉一次。
  const syncSessionModel = modelsApi.syncSession
  useEffect(() => {
    if (!currentID) {
      setMessages([])
      return
    }
    if (!connected) return
    void loadSession(currentID)
  }, [currentID, connected, loadSession])

  // 会话元数据变化（换了模型/改了标题）时同步显示，但不重拉历史
  const currentSession = sessions.find((item) => item.id === currentID)
  useEffect(() => {
    syncSessionModel(currentSession)
  }, [currentSession, syncSessionModel])

  /**
   * 子会话（子智能体）不在顶层列表里：按 id 补查一次，供标题/标签用。
   * 查不到就把上一次的丢掉，别让标题粘在别的会话上。
   */
  useEffect(() => {
    if (!connected || !currentID) {
      setExtraSession(null)
      return
    }
    if (sessions.some((item) => item.id === currentID)) {
      setExtraSession(null)
      return
    }
    let alive = true
    void getSession(currentID)
      .then((session) => {
        if (alive) setExtraSession(session)
      })
      .catch(() => {
        if (alive) setExtraSession(null)
      })
    return () => {
      alive = false
    }
  }, [connected, currentID, sessions])

  useChatEvents(connected, currentID, refreshSession, applyStream)

  /**
   * 距底部多少像素以内算「贴底」。
   *
   * 只留几像素余量吸收亚像素误差。以前是 80px：往上滚了大半屏仍然算贴底，
   * 流式输出每来一段就被拽回底部 —— 这就是「翻不上去、一直被刷新」的根源。
   */
  const BOTTOM_SLACK = 12

  /**
   * 往更早翻一页：把旧记录补进列表，并保持视口不跳。
   *
   * 补进来的是列表上方的旧内容，滚动高度会变大；不补偏移的话
   * 用户会感觉画面被猛地拽走。
   */
  const loadOlder = useCallback(async () => {
    const sessionID = currentRef.current
    const cursor = olderCursorRef.current
    if (!sessionID || !cursor || loadingOlder) return
    setLoadingOlder(true)
    const el = scrollRef.current
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0
    try {
      const page = await listMessagePage(sessionID, cursor)
      if (currentRef.current !== sessionID) return
      if (page.messages.length === 0) {
        olderCursorRef.current = undefined
        setHasOlder(false)
        return
      }
      setMessages((prev) => mergeMessages(prev, page.messages))
      olderCursorRef.current = page.next
      setHasOlder(Boolean(page.next))
      requestAnimationFrame(() => {
        const node = scrollRef.current
        if (node && fromBottom > 0) node.scrollTop = node.scrollHeight - fromBottom
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoadingOlder(false)
    }
  }, [loadingOlder])

  /**
   * 滚动处理：读完布局信息立刻更新「是否贴底」。
   *
   * 原实现每次 scroll 都同步读 scrollHeight/clientHeight 再 setState。滚动事件
   * 一帧内可能来好几次，每次强制 layout 就是滚动卡顿的直接原因；这里压到每帧
   * 最多一次，而且只有贴底状态真的变了才写 state。
   */
  const scrollFrame = useRef<number | null>(null)
  const onBodyScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    /*
     * 「用户是否贴底」必须同步更新。
     *
     * 放到 rAF 里会晚一帧：这一帧的贴底跟随（messages 变化触发的滚动）先跑，
     * 把用户刚拉上去的位置又滚回底部，滚动事件这才到、判定「仍然贴底」，
     * 于是永远翻不上去。同步读一次 scrollTop 的开销远小于这个体验问题。
     */
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK

    if (scrollFrame.current !== null) return
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null
      // 值没变时 setState 会被 React 直接跳过，不需要自己再比一次
      setAtBottom(stickRef.current)
      const node = scrollRef.current
      // 滚到接近顶部就自动续拉更早的记录（不用再点浮层里的按钮）
      if (node && node.scrollTop < 200) void loadOlder()
    })
  }, [loadOlder])

  useEffect(
    () => () => {
      if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current)
      scrollFrame.current = null
    },
    [],
  )

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stickRef.current = true
    setAtBottom(true)
    // 离屏轮次的高度是估算值（content-visibility）：这一帧滚到底后，
    // 真实高度落定会让 scrollHeight 变大，再补一次才真的贴到底。
    window.requestAnimationFrame(() => {
      const node = scrollRef.current
      if (node && stickRef.current) node.scrollTop = node.scrollHeight
    })
  }, [])

  // 内容变化时只在「本来就贴底」的情况下跟随；翻上去看历史就原地不动。
  // 合并到下一帧：同一帧内多次 messages 变化只滚一次，别每次都强制同步布局。
  useEffect(() => {
    if (!stickRef.current) return
    const frame = window.requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el && stickRef.current) el.scrollTop = el.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [messages])

  // 内容还没撑满一屏时先自动补一页：否则「有更早的记录」却连滚动条都没有，
  // 触不到滚动事件就永远补不上。
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !hasOlder || loadingOlder) return
    if (el.scrollHeight <= el.clientHeight + BOTTOM_SLACK) void loadOlder()
  }, [hasOlder, loadingOlder, messages, loadOlder])

  // 切会话：新会话从头看起，直接回到最新一条。
  useEffect(() => {
    stickRef.current = true
    setAtBottom(true)
  }, [currentID])

  // 切会话时把该会话的压缩记录读回来：刷新页面、重开工作台都还在。
  useEffect(() => {
    setCompactLog(currentID ? loadCompactLog(currentID) : [])
  }, [currentID])

  /**
   * 没有当前会话就先建一个（命令和普通消息共用）。
   *
   * 不预置标题：标题交给服务端在首条消息后生成，和 TUI 一致。
   * 以前拿首句截前 20 字当标题，会出现一堆「https://github.com/c」这种半截串，
   * 而且从此再也不会被改名。
   */
  async function ensureSession(): Promise<string | null> {
    if (currentRef.current) return currentRef.current
    try {
      const session = await createSession(root, undefined, modelsApi.model ?? undefined)
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
        // 新会话是另一份历史：整份替换，别和原会话的消息合并
        await loadSession(forked.id)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setBusy(false)
      }
      return
    }
    if (name === 'compact') {
      await compactContext()
      return
    }
    if (name === 'agents') {
      setError('请用斜杠菜单选择 agent：输入 / 后选 agents')
    }
  }

  /**
   * 压缩上下文：长会话的出口之一。
   *
   * 压缩会把历史重写成摘要，成功后必须整份重拉；走合并会让原始消息
   * 和摘要混在一起，越看越乱。
   *
   * 整个过程是同步阻塞在服务端的一次 HTTP 上（几十秒到几分钟），所以三个
   * 阶段的反馈都得自己给：开始写一条进行中的提示、结束写压缩前后的 token
   * 数和耗时、失败写原因。浮层里那个「压缩中…」只在鼠标停在上面时可见，
   * 不能当唯一反馈。
   */
  async function compactContext() {
    const sessionID = currentRef.current
    if (!sessionID) {
      setError('当前没有会话，先发一条消息再压缩')
      return
    }
    if (compacting) return

    const startedAt = Date.now()
    const before = computeContextUsage(messages, 0).used
    setCompacting(true)
    setError(null)
    setNotice({
      tone: 'info',
      text: '正在压缩上下文…',
      detail:
        before > 0
          ? `当前约 ${formatTokens(before)} token；压缩期间会重写历史，别关页面`
          : '压缩期间会重写历史，别关页面',
    })
    try {
      await compactSession(sessionID)
      runningApi.start(sessionID)
      const fresh = await loadSession(sessionID)

      // 服务端可能回 200，但在新写出的 compaction 消息上带 error
      // （例如「Nothing to compact yet」）。不看它就会把失败当成功，
      // 界面还会显示「461k → 461k」这种什么都没发生的数字。
      const justNow = startedAt - 5_000
      const created = fresh?.find(
        (message) => message.type === 'compaction' && (message.time?.created ?? 0) >= justNow,
      )
      const failure = created?.error?.message?.trim()
      if (failure) throw new Error(failure)

      const finishedAt = Date.now()
      const after = fresh ? computeContextUsage(fresh, 0).used : 0
      const ms = finishedAt - startedAt
      // 记录先落盘再判断：压缩途中切走会话时，这一条仍属于原会话
      const next = appendCompactRecord(sessionID, {
        at: finishedAt,
        ok: true,
        before,
        after,
        ms,
      })
      if (currentRef.current !== sessionID) return
      setCompactLog(next)
      const seconds = Math.max(1, Math.round(ms / 1000))
      const size = before > 0 && after > 0 ? `${formatTokens(before)} → ${formatTokens(after)}` : null
      setNotice({
        tone: 'ok',
        text: size ? `上下文已压缩：${size}（${seconds}s）` : `上下文已压缩（${seconds}s）`,
        detail: '历史已重写成摘要，更早的原始消息不再进入下一次请求',
      })
    } catch (err) {
      const message = (err as Error).message
      const next = appendCompactRecord(sessionID, {
        at: Date.now(),
        ok: false,
        before,
        after: 0,
        ms: Date.now() - startedAt,
        error: message,
      })
      if (currentRef.current === sessionID) {
        setCompactLog(next)
        setNotice({ tone: 'fail', text: `压缩失败：${message}` })
      } else {
        setError(message)
      }
    } finally {
      setCompacting(false)
    }
  }

  /** 切换当前会话的 agent（界面上的「模式」）。 */
  async function pickAgent(id: string) {
    const sessionID = await ensureSession()
    if (!sessionID) return
    setError(null)
    try {
      await switchAgent(sessionID, id)
      setAgent(id)
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
    // 用户已经继续往下走了：上一条压缩结果提示让位
    setNotice(null)

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
        const sessionID = await ensureSession()
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

    const sessionID = await ensureSession()
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
      // 还没有标题的会话：服务端会在这一轮之后生成，期间盯着点
      if (!sessionsRef.current.find((item) => item.id === sessionID)?.title?.trim()) {
        watchTitle(sessionID)
      }
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

  /** 新会话：不带标题建，等服务端在第一条消息后自动起名（和 TUI 一样）。 */
  async function newSession() {
    try {
      const session = await createSession(root, undefined, modelsApi.model ?? undefined)
      setSessions((prev) => [session, ...prev])
      setCurrentID(session.id)
      setExpanded(false)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // 当前模型的上下文上限：没有它就算不出百分比
  const modelInfo = useMemo(
    () =>
      modelsApi.models.find(
        (model) =>
          model.id === modelsApi.model?.id && model.providerID === modelsApi.model?.providerID,
      ),
    [modelsApi.models, modelsApi.model],
  )
  const usage = useMemo(
    () => computeContextUsage(messages, modelInfo?.limit?.context ?? 0),
    [messages, modelInfo],
  )
  // 输入框下方的统计条：轮/步、token 总量、缓存命中、tok/s。
  //
  // 生成过程中光靠消息变化推不动读数：tokens 要等这一步结束才落地，模型思考时
  // 连 delta 都没有。所以跑着的时候每 500ms 走一次心跳，让时间和速度跟着走。
  //
  // 心跳条件看「有没有未完成的 assistant 消息」，不只看 running 轮询：轮询有
  // 延迟，漏一拍读数就整段冻住。算的时候一律用 Date.now()，不拿旧的时间戳凑。
  const streaming = useMemo(
    () =>
      messages.some(
        (message) => message.type === 'assistant' && typeof message.time?.completed !== 'number',
      ),
    [messages],
  )
  const [statsNow, setStatsNow] = useState(() => Date.now())
  useEffect(() => {
    if (!runningApi.running && !streaming) return
    setStatsNow(Date.now())
    const timer = window.setInterval(() => setStatsNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [runningApi.running, streaming])

  /**
   * 统计输入用「节流后的快照」，不是每个 delta 都算一遍。
   *
   * computeSessionStats 要遍历所有消息的 parts：长会话里一次 1~4ms，
   * 流式 30~50 delta/s 就是每步累计上千毫秒的主线程占用。读数本来就只需要
   * 看得清变化，150ms 一次足够，心跳仍是 500ms。
   */
  const [statsSource, setStatsSource] = useState<ChatMessage[]>(messages)
  useEffect(() => {
    if (!runningApi.running && !streaming) {
      setStatsSource(messages)
      return
    }
    const timer = window.setTimeout(() => setStatsSource(messages), 150)
    return () => window.clearTimeout(timer)
  }, [messages, runningApi.running, streaming])
  const stats = useMemo(() => computeSessionStats(statsSource, Date.now()), [statsSource, statsNow])

  // 当前会话：顶层列表里有就用它，没有就用补查到的子会话信息
  const current =
    sessions.find((session) => session.id === currentID) ??
    (extraSession && extraSession.id === currentID ? extraSession : undefined)
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

  // 把当前会话信息报给标签栏：子会话不在轮询列表里，标题和灯只能从这儿来
  useEffect(() => {
    if (current) onSessionInfo?.(current)
  }, [current, onSessionInfo])

  // 生成状态也报一份：标签上的黄灯对子会话同样要准
  useEffect(() => {
    if (currentID) onSessionRunning?.(currentID, runningApi.running)
  }, [currentID, runningApi.running, onSessionRunning])

  // 卸载（切到别的标签）时上报「不知道」：否则最后一帧的黄灯会永久留在那个标签上
  const reportRunningRef = useRef(onSessionRunning)
  reportRunningRef.current = onSessionRunning
  useEffect(() => {
    if (!currentID) return
    return () => reportRunningRef.current?.(currentID, null)
  }, [currentID])

  return (
    <div className="chat">
      <ChatHeader
        sessions={visibleSessions}
        lights={lights}
        hiddenCount={hiddenCount}
        showAll={showAllSessions}
        agents={agents}
        currentAgent={agent || agents[0]?.id || ''}
        onPickAgent={(id) => void pickAgent(id)}
        onToggleShowAll={() => setShowAllSessions((value) => !value)}
        current={current}
        expanded={expanded}
        models={modelsApi.models}
        modelsLoading={modelsApi.loading}
        modelsError={modelsApi.error}
        onRetryModels={() => void modelsApi.reload()}
        onRefreshModels={() => void modelsApi.refresh()}
        currentModel={modelsApi.model}
        connected={connected}
        onToggleSessions={() => setExpanded((value) => !value)}
        onPickSession={(id) => {
          setCurrentID(id)
          setExpanded(false)
        }}
        onNewSession={() => void newSession()}
        onOpenInPanel={onOpenInPanel}
        panelIDs={panelIDs}
        onPickModel={(next) => void pickModel(next)}
        onPickVariant={(next, variant) => void pickModelVariant(next, variant)}
        context={{
          usage,
          compacting,
          onCompact: () => void compactContext(),
        }}
        purge={purgeApi}
      />

      {error ? <div className="chat-warn">{error}</div> : null}

      <div className="chat-body-wrap">
        <div className="chat-body" ref={scrollRef} onScroll={onBodyScroll}>
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
              scrollRef={scrollRef}
            />
          )}
          {/* 压缩记录放在消息流末尾：历史被重写之后，这里还能看到压过几次、各是多大 */}
          <CompactLog
            records={compactLog}
            onClear={() => {
              const sessionID = currentRef.current
              if (!sessionID) return
              clearCompactLog(sessionID)
              setCompactLog([])
            }}
          />
        </div>
        {messages.length > 0 && !atBottom ? (
          <button type="button" className="chat-jump" onClick={jumpToBottom} title="跳到最新一条">
            ↓ 回到最新
          </button>
        ) : null}
      </div>

      {notice ? (
        <div className={`chat-notice ${notice.tone}`} role="status" aria-live="polite">
          {notice.tone === 'info' ? <span className="chat-notice-spin" aria-hidden /> : null}
          <span className="chat-notice-text">{notice.text}</span>
          {notice.detail ? <span className="chat-notice-detail">{notice.detail}</span> : null}
          <button
            type="button"
            className="chat-notice-close"
            title="关闭提示"
            aria-label="关闭提示"
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </div>
      ) : null}

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
        footer={<SessionStatsBar stats={stats} />}
      />
    </div>
  )
}
