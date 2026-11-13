import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { SessionInfo } from '../api/chat'
import { sessionLight, sessionLightTitle, type SessionLike } from './sessionLight'
import Chat from './Chat'
import { Icon } from './Icon'

/**
 * 会话标签栏：一个聊天区，多条会话并排成标签。
 *
 * 和「并排多列」的区别：同一时刻只渲染一个 Chat，宽度全给当前会话，
 * 不是把 500px 切成两半。标签上带状态灯，所以切走以后仍然能看出
 * 别的会话在不在跑——这才是「不用来回切」的关键。
 *
 * 标签不是会话的数据库：每个标签只是「指向某条会话」的一格槽位，
 * 里面 Chat 自己换会话（下拉/新建）时通过 onSessionChange 回报，
 * 标签跟着改指向。
 */
export const MAX_TABS = 6

const TABS_KEY = 'oc-workbench:chat-tabs'

export type ChatTab = {
  /** 槽位 id，不随会话变：关掉别的标签时不会串位 */
  id: string
  /** 指向的会话；undefined = 还没建（用户点了 + 但没发消息） */
  sessionID?: string
  /**
   * 这一格是不是「刚进工作台时自动开的那一格」。
   * 只有它允许自动挑一条最近的会话填进去；用户自己点 + 出来的空格子要保持空白。
   */
  pick?: boolean
}

type Props = {
  root: string
  connected: boolean
  onOpenFile: (path: string, line?: number) => void
  lights?: Map<string, SessionLike & { title?: string }>
  /** 外部要求打开某条会话（会话列表里的 ⧉） */
  request?: { sessionID: string; seq: number } | null
  /** 当前激活的会话变了：主界面靠它知道该列谁的子智能体 */
  onActiveSession?: (sessionID: string | null) => void
}

/** 一条会话的存储结构：标签顺序 + 上次激活的是哪一格。 */
type StoredTabs = { list: ChatTab[]; activeID: string }

/** 读上次打开的标签（只恢复会话 id，消息重新拉）。 */
function readTabs(root: string): StoredTabs {
  const empty = { list: [], activeID: '' }
  try {
    const raw = window.localStorage.getItem(TABS_KEY)
    if (!raw) return empty
    const parsed = JSON.parse(raw) as Record<string, StoredTabs>
    const saved = parsed[root]
    if (!saved?.list || !Array.isArray(saved.list)) return empty
    const list = saved.list
      .filter((tab) => tab && typeof tab.id === 'string')
      .slice(0, MAX_TABS)
      .map((tab) => ({ id: tab.id, sessionID: tab.sessionID }))
    // 激活的那格可能已经被裁掉了：回退到第一格，别留一个空 activeID
    const activeID = list.some((tab) => tab.id === saved.activeID)
      ? saved.activeID
      : (list[0]?.id ?? '')
    return { list, activeID }
  } catch {
    // 存储坏了/被禁用：当作没开过标签，不影响主界面
    return empty
  }
}

function saveTabs(root: string, tabs: ChatTab[], activeID: string): void {
  try {
    const raw = window.localStorage.getItem(TABS_KEY)
    const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, StoredTabs>
    // 标签顺序照用户看到的存：以前把激活的挪到第一位，重开以后顺序会跳
    parsed[root] = { list: tabs.map((tab) => ({ id: tab.id, sessionID: tab.sessionID })), activeID }
    window.localStorage.setItem(TABS_KEY, JSON.stringify(parsed))
  } catch {
    /* 存不进去只影响下次启动的恢复 */
  }
}

/** 新建一个空槽位 id：不用 Math.random，时间戳 + 序号已经够唯一。 */
function nextTabID(seq: number): string {
  return `tab-${Date.now().toString(36)}-${seq}`
}

export default function ChatTabs({
  root,
  connected,
  onOpenFile,
  lights,
  request,
  onActiveSession,
}: Props) {
  // 初始化只读一次 storage：读两遍在 root 变化时可能拿到不同的快照
  const [tabs, setTabs] = useState<ChatTab[]>(() => readTabs(root).list)
  const [activeID, setActiveID] = useState<string>(() => readTabs(root).activeID)
  const [seq, setSeq] = useState(0)
  /**
   * Chat 上报的会话信息（标题 + 是否在跑）：子会话不在轮询列表里，
   * 顶层 lights 拿不到它，标签只能靠这份兜底。
   * running 三态：true 在跑 / false 空闲 / undefined 不知道（Chat 卸载后）→ 显示灰灯。
   */
  const [extraInfo, setExtraInfo] = useState<
    Record<string, { title?: string; running?: boolean }>
  >({})

  // 切项目：换成那个项目自己的标签配置
  useEffect(() => {
    const saved = readTabs(root)
    setTabs(saved.list)
    setActiveID(saved.activeID)
  }, [root])

  // 一个标签都没有时补一个空槽位：首次进入也要有地方聊天
  useEffect(() => {
    if (tabs.length > 0) return
    // 首次进入自动开的那一格：允许自动挑最近会话
    const tab = { id: nextTabID(0), pick: true }
    setTabs([tab])
    setActiveID(tab.id)
    setSeq(1)
  }, [tabs.length])

  const activeTab = tabs.find((tab) => tab.id === activeID) ?? tabs[0]

  /** 打开某条会话的标签：外部请求和列表里的 ⧉ 共用这一份逻辑。 */
  const openSessionTabRef = useRef<(id: string) => void>(() => {})

  /** 外部请求（会话列表里的 ⧉ / 子智能体面板）：带着 seq 来，同一个 id 也能再触发 */
  useEffect(() => {
    if (!request?.sessionID) return
    openSessionTabRef.current(request.sessionID)
  }, [request])

  // 标签 → 会话 id 集合：给会话列表做「已打开」标记
  const openedIDs = useMemo(() => {
    const out = new Set<string>()
    for (const tab of tabs) if (tab.sessionID) out.add(tab.sessionID)
    return out
  }, [tabs])
  const activeSessionID = activeTab?.sessionID ?? null
  useEffect(() => {
    onActiveSession?.(activeSessionID)
  }, [activeSessionID, onActiveSession])

  useEffect(() => {
    if (!activeTab) return
    saveTabs(root, tabs, activeTab.id)
  }, [root, tabs, activeTab])

  /** Chat 里换了会话（下拉/新建）：把这格标签改成指向它。 */
  const followSession = useCallback(
    (sessionID: string | null) => {
      if (!activeTab) return
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === activeTab.id ? { ...tab, sessionID: sessionID ?? undefined } : tab,
        ),
      )
    },
    [activeTab],
  )
  /**
   * 子会话（子智能体）不在轮询列表里：Chat 把它的信息报上来，标签栏留着当兜底。
   * 用 useCallback 固定引用：这是传给 Chat 的 effect 依赖，每次渲染换新函数会白跑。
   */
  const rememberSession = useCallback((session: { id: string; title?: string }) => {
    setExtraInfo((prev) => {
      const title = session.title?.trim()
      const old = prev[session.id]
      if (old && old.title === title) return prev
      return { ...prev, [session.id]: { title, running: old?.running ?? false } }
    })
  }, [])

  const rememberRunning = useCallback((sessionID: string, running: boolean | null) => {
    setExtraInfo((prev) => {
      const old = prev[sessionID]
      // null = 不知道：清成 undefined，标签按灰灯显示，别留着上一次的黄
      const next = running === null ? undefined : running
      if (old && old.running === next) return prev
      return { ...prev, [sessionID]: { title: old?.title, running: next } }
    })
  }, [])

  /** 会话列表里的 ⧉：已经在某个标签里就跳过去，否则占一个空槽位。 */
  const openSessionTab = useCallback(
    (sessionID: string) => {
      setTabs((prev) => {
        const hit = prev.find((tab) => tab.sessionID === sessionID)
        if (hit) {
          setActiveID(hit.id)
          return prev
        }
        // 空槽位（点了 + 还没聊）优先复用，别白留一格
        const blank = prev.findIndex((tab) => !tab.sessionID)
        if (blank >= 0) {
          setActiveID(prev[blank].id)
          return prev.map((tab, index) => (index === blank ? { ...tab, sessionID } : tab))
        }
        if (prev.length >= MAX_TABS) return prev
        const tab = { id: nextTabID(seq), sessionID }
        setSeq((value) => value + 1)
        setActiveID(tab.id)
        return [...prev, tab]
      })
    },
    [seq],
  )
  // 外部请求的 effect 定义在上面，这里把最新实现挂进去
  openSessionTabRef.current = openSessionTab

  /** + 号：加一个空槽位，用户在里头发第一条消息时才真的建会话。 */
  const openNewTab = useCallback(() => {
    setTabs((prev) => {
      if (prev.length >= MAX_TABS) return prev
      // 用「现有最大序号 + 1」当后缀，而不是闭包里的 seq：
      // seq 是异步的，同一事件循环里连点两次会拿到同一个值，生成重复 id
      const used = new Set(prev.map((tab) => tab.id))
      let next = 0
      while (used.has(nextTabID(next))) next += 1
      const tab = { id: nextTabID(next) }
      setSeq((value) => value + 1)
      setActiveID(tab.id)
      return [...prev, tab]
    })
  }, [])

  const closeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        if (prev.length <= 1) {
          // 只剩一格时不允许关：关掉它 Chat 会重新挂载并自动绑回最近的会话，
          // 看起来像「没关掉」，不如干脆不给这个入口（× 在 UI 上也隐藏了）。
          return prev
        }
        const index = prev.findIndex((tab) => tab.id === id)
        const next = prev.filter((tab) => tab.id !== id)
        // 关掉的是当前这格：顺位切到右边一格，没有就切左边
        if (id === activeID) {
          const fallback = next[Math.min(index, next.length - 1)]
          if (fallback) setActiveID(fallback.id)
        }
        return next
      })
    },
    [activeID],
  )

  return (
    <div className="chat-tabbed">
      <div className="chat-tabs" role="tablist" aria-label="会话标签">
        {tabs.map((tab) => {
          const info = tab.sessionID ? lights?.get(tab.sessionID) : undefined
          // 子会话（子智能体）不在轮询列表里：用 Chat 上报的那份兜底
          const extra = tab.sessionID ? extraInfo[tab.sessionID] : undefined
          // 三态：轮询有数据就用它；否则看 Chat 上报的 running；都没有就是「不知道」→ 灰灯
          const light = !tab.sessionID
            ? 'unknown'
            : info
              ? sessionLight(info as SessionLike, connected)
              : extra?.running === undefined
                ? 'unknown'
                : sessionLight(
                    { time: extra.running ? { busy: 1, idle: 0 } : { busy: 0, idle: 1 } },
                    connected,
                  )
          const title = tab.sessionID
            ? info?.title?.trim() || extra?.title?.trim() || '新会话'
            : '新会话'
          const isActive = tab.id === activeTab?.id
          return (
            <div
              key={tab.id}
              className={`chat-tab${isActive ? ' active' : ''}`}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              title={tab.sessionID ? `${title}\n${sessionLightTitle(light)}` : '新会话'}
              onClick={() => setActiveID(tab.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setActiveID(tab.id)
                }
              }}
              // 中键关闭：和浏览器标签一致
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  closeTab(tab.id)
                }
              }}
            >
              <span className={`chat-session-light ${light}`} aria-hidden="true" />
              <span className="chat-tab-title">{title}</span>
              {/* 只剩一格时不给关闭入口：关掉会重挂载并自动绑回最近会话，看着像没关 */}
              {tabs.length > 1 ? (
                <button
                  type="button"
                  className="chat-tab-close"
                  title="关闭标签（不会删会话）"
                  aria-label="关闭标签"
                  onClick={(event) => {
                    // 别让点关闭顺带把这一格也激活
                    event.stopPropagation()
                    closeTab(tab.id)
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          )
        })}
        {tabs.length < MAX_TABS ? (
          <button
            type="button"
            className="chat-tab-add"
            title="新标签（另一条会话）"
            aria-label="新标签"
            onClick={openNewTab}
            disabled={!connected}
          >
            <Icon name="plus" size={11} />
          </button>
        ) : null}
      </div>

      {activeTab ? (
        <Chat
          // 换标签就重挂载：每个标签各自的历史/滚动/草稿互不串
          key={`${root}:${activeTab.id}`}
          root={root}
          tabID={activeTab.id}
          connected={connected}
          onOpenFile={onOpenFile}
          initialSessionID={activeTab.sessionID}
          // 只有「刚进工作台自动开的那一格」才挑最近会话；用户点 + 出来的空格子、
          // 以及已经指向某条会话的格子（含子智能体那种不在列表里的）都不许动
          autoPickSession={Boolean(activeTab.pick) && !activeTab.sessionID}
          lights={lights}
          onSessionChange={followSession}
          onOpenInPanel={openSessionTab}
          panelIDs={openedIDs}
          onSessionInfo={rememberSession}
          onSessionRunning={rememberRunning}
        />
      ) : null}
    </div>
  )
}

/** 只导出类型用得到的东西，避免调用方再 import 一次 SessionInfo。 */
export type { SessionInfo }
