/**
 * 历史会话选择面板（点标题旁边那颗「会话 ▾」展开）。
 *
 * 为什么单独成文件：
 *   ChatHeader 已经有 470 多行，再把搜索和分组塞进去就越过「单文件 300 行」的硬线。
 *   这里只做「挑一条历史会话」，跟头部其它下拉（模型/模式/档位）互不相干。
 *
 * 三件事是这次新加的，都是为了让「翻历史」快一点：
 *   1. 关键字搜索：项目聊久了列表能到几十条，靠眼睛扫太慢
 *   2. 按日期分组（今天 / 昨天 / 近 7 天 / 更早）：翻历史时人的参照系是日历
 *   3. 搜索框吸顶 + 面板加高：滚动时输入框不跟着跑掉
 *
 * 类名保持原来的 `.chat-sessions` / `.chat-session-item` 等：
 *   verify-draft-sessions / smoke-mobile-features 这些验收脚本靠它们定位，
 *   改了名字会让那些脚本静默失效（找不到元素就跳过，看起来像「全过」）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import { LEGACY_PLACEHOLDER_TITLE, sessionLastAt, type SessionInfo } from '../api/chat'
import { formatClock, formatDateTime } from './turns'
import { lightFromSnapshot, sessionLightTitle, type SessionLike } from './sessionLight'
import { filterSessions, groupSessions } from './sessionList'

export function shortTitle(session: SessionInfo): string {
  const title = session.title?.trim()
  // 空标题＝刚建、服务端还在等第一条消息起名；占位标题＝老版本写死的那种。
  // 两种都显示「新会话」，别把会话 id 片段当成名字露出来。
  if (!title || title === LEGACY_PLACEHOLDER_TITLE) return '新会话'
  return title
}

/** 会话灯：走共用判定，快照里没有这条就是灰（不做「空闲」承诺）。 */
function lightFor(
  session: SessionInfo,
  lights: Map<string, SessionLike> | undefined,
  connected: boolean,
) {
  return lightFromSnapshot(session.id, lights, connected)
}

type Props = {
  sessions: SessionInfo[]
  lights?: Map<string, SessionLike>
  current: SessionInfo | undefined
  connected: boolean
  onPick: (id: string) => void
  /** 在新标签里打开这条会话；不传就不显示 ⧉ */
  onOpenInPanel?: (id: string) => void
  /** 已经开在标签里的会话 id */
  panelIDs?: Set<string>
  /** 被「只显示工作台会话」过滤掉的外部会话数量 */
  hiddenCount: number
  showAll: boolean
  onToggleShowAll: () => void
  /** 收起整个面板（Esc 用）。不传就只是清空搜索 */
  onClose?: () => void
}
export default function SessionMenu({
  sessions,
  lights,
  current,
  connected,
  onPick,
  onOpenInPanel,
  panelIDs,
  hiddenCount,
  showAll,
  onToggleShowAll,
  onClose,
}: Props) {
  const [keyword, setKeyword] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // 展开就应该能直接打字：历史多的时候打字比翻找快得多
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filtered = useMemo(() => filterSessions(sessions, keyword), [sessions, keyword])
  const groups = useMemo(() => groupSessions(filtered), [filtered])

  return (
    <div className="chat-sessions">
      <div className="chat-session-search">
        <input
          ref={inputRef}
          className="chat-session-filter"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索历史会话"
          // Esc：有关键字先清空（不收起），没关键字才收起整个面板 ——
          // 以前只清空、且吞掉事件，面板永远关不掉，只能用鼠标点 toggle。
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            if (keyword) {
              setKeyword('')
              return
            }
            onClose?.()
          }}
        />
        {keyword ? (
          <button
            type="button"
            className="chat-session-filter-clear"
            title="清空搜索"
            aria-label="清空搜索"
            onClick={() => setKeyword('')}
          >
            ×
          </button>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <div className="chat-session-empty">
          {sessions.length === 0 ? '还没有会话' : `没有匹配「${keyword.trim()}」的会话`}
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.key} className="chat-session-group">
            <div className="chat-session-group-label">{group.label}</div>
            {group.items.map((session) => {
              const at = sessionLastAt(session)
              const light = lightFor(session, lights, connected)
              const opened = panelIDs?.has(session.id) ?? false
              return (
                <div
                  key={session.id}
                  className={`chat-session-item${session.id === current?.id ? ' active' : ''}`}
                >
                  <button
                    type="button"
                    className="chat-session-main"
                    title={`${sessionLightTitle(light)}${
                      at ? `\n最后一次对话 ${formatDateTime(at)}` : ''
                    }${opened ? '\n已开在标签里' : ''}`}
                    onClick={() => onPick(session.id)}
                  >
                    <span className={`chat-session-light ${light}`} aria-hidden="true" />
                    <span className="chat-session-title">{shortTitle(session)}</span>
                  </button>
                  {at ? <span className="chat-session-time">{formatClock(at)}</span> : null}
                  {onOpenInPanel ? (
                    <button
                      type="button"
                      className="chat-session-split"
                      title={opened ? '已在标签里' : '在标签里打开'}
                      aria-label={opened ? '已在标签里' : '在标签里打开'}
                      disabled={opened}
                      onClick={() => onOpenInPanel(session.id)}
                    >
                      ⧉
                    </button>
                  ) : null}
                </div>
              )
            })}
          </div>
        ))
      )}

      {/*
       * 默认已经是「全部会话」，这块只在需要收窄时出现：
       * 外部会话（CLI / TUI 建的）多于 0 条时才给「只看工作台」的入口，
       * 收窄之后必须能一键切回来。
       */}
      {hiddenCount > 0 ? (
        <button type="button" className="chat-session-more" onClick={onToggleShowAll}>
          {showAll ? `只看工作台会话（另有 ${hiddenCount} 条外部会话）` : '显示全部会话'}
        </button>
      ) : null}
    </div>
  )
}
