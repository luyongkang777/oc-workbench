import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentInfo } from '../api/chat'
import { formatBytes } from './codeWindow'
import { isImageMime, type ChatAttachment } from './attachments'
import { filterCommands, type CommandItem } from './chatCommands'
import {
  applyMention,
  baseName,
  dirName,
  filterHits,
  nextMenuForSlash,
  parseMentionAt,
  shouldResetHits,
  type MentionHit,
} from './fileMention'
import { isMobileViewport, MOBILE_MAX_HEIGHT, MOBILE_MAX_WIDTH } from '../hooks/useMobileLayout'
import { Icon } from './Icon'

type Props = {
  draft: string
  busy: boolean
  running: boolean
  connected: boolean
  commands: CommandItem[]
  agents: AgentInfo[]
  /** 待发送的图片/文件（缩略图显示在输入框上方） */
  attachments: ChatAttachment[]
  onDraftChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  /** 把前台阻塞的工具挪到后台（只在生成中可用） */
  onBackground: () => void
  /** 按关键字搜工作区的相对路径（@ 补全用）。返回空数组表示没匹配 */
  onFindFiles: (query: string) => Promise<MentionHit[]>
  onBuiltin: (name: string) => void
  onPickAgent: (id: string) => void
  onAddFiles: (files: File[]) => void
  onRemoveAttachment: (id: string) => void
  /**
   * 「回到上一版」：把最近一轮的代码改动撤回（含该轮消息）。
   * 不传就不渲染这个按钮。
   */
  onUndo?: () => void
  /** 按钮是否可用：没有可回退的一轮 / 生成中 / 已在回撤状态时禁用 */
  undoDisabled?: boolean
  /** 悬停提示：禁用时说明原因 */
  undoTitle?: string
  /** 打开「修改记录」面板（最近 N 个节点，先审核再回溯） */
  onHistory?: () => void
  /** 没有可回溯的修改时禁用 */
  historyDisabled?: boolean
  historyTitle?: string
  /** 输入框上方的附加区（会话统计条）。放在 wrap 内，好共用内边距和分隔，输入框保持贴底 */
  footer?: ReactNode
}

/**
 * 输入区：生成中把「发送」换成「停止」。
 *
 * 选择模式：输入框里只有一段以 / 开头、还没空格的文本时，弹出命令菜单；
 * ↑↓ 选择、Enter/Tab 确认、Esc 关闭；选中 agents 会进入二级 agent 列表。
 */
export default function ChatInput({
  draft,
  busy,
  running,
  connected,
  commands,
  agents,
  attachments,
  onDraftChange,
  onSend,
  onStop,
  onBackground,
  onFindFiles,
  onBuiltin,
  onPickAgent,
  onAddFiles,
  onRemoveAttachment,
  onUndo,
  undoDisabled,
  undoTitle,
  onHistory,
  historyDisabled,
  historyTitle,
  footer,
}: Props) {
  /*
   * 手机屏上那条长提示会折成两行、把输入框挤满：窄视口换成一句短的。
   * 必须走 useState 而不是直接调：窗口从桌面拖窄时组件不会重挂载，
   * 直接取值会一直停在首帧（宽的），提示语永远不切。
   */
  const [compactHint, setCompactHint] = useState(() => isMobileViewport())
  const [menu, setMenu] = useState<'commands' | 'agents' | 'files' | null>(null)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  /** @ 提及：正在输入的那一段 + 候选路径 */
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null)
  const [fileHits, setFileHits] = useState<MentionHit[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const canSend = connected && !busy && (draft.trim().length > 0 || attachments.length > 0)

  const slashQuery = /^\/([^\s]*)$/.exec(draft)?.[1] ?? null
  const filtered = useMemo(
    () => filterCommands(commands, slashQuery ?? ''),
    [commands, slashQuery],
  )

  /**
   * 输入框随内容长高（1~6 行），超过就内部滚动。
   *
   * 只给桌面/宽列用：手机上 CSS 已经把高度钉死在 48（矮屏 40）并靠内部滚动，
   * 内联 style.height 的优先级高于任何 CSS 规则，在这里无条件写会把那两档顶掉。
   *
   * textarea 的 scrollHeight 永远反映全部内容，所以先归零再取，才能得到
   * 「实际需要的高度」；不归零只会一路累加到 max-height 卡死。
   */
  useEffect(() => {
    const node = areaRef.current
    if (!node) return
    if (isMobileViewport()) {
      node.style.height = ''
      return
    }
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`
  }, [draft])

  // 视口跨过手机档时同步提示语：useMobileLayout 已挂 resize + matchMedia 两条来源，
  // 这里同样两条一起挂，避免 CDP 仿真下 matchMedia 不派发导致提示不切。
  // 断点用 useMobileLayout 的常量：这里再写死 800/520，改了那边就对不上。
  useEffect(() => {
    const sync = () => setCompactHint(isMobileViewport())
    const query = window.matchMedia(
      `(max-width: ${MOBILE_MAX_WIDTH}px), (max-height: ${MOBILE_MAX_HEIGHT}px)`,
    )
    sync()
    query.addEventListener('change', sync)
    window.addEventListener('resize', sync)
    return () => {
      query.removeEventListener('change', sync)
      window.removeEventListener('resize', sync)
    }
  }, [])
  // 只有在「输入以 / 开头且还没空格」时才进入选择模式；Esc 关闭后不再自动弹回
  //
  // 这个 effect 只管「命令 / agent」两种菜单。@ 文件菜单归 syncMention 与它自己的
  // 搜索 effect 管：这里无条件 setMenu(null) 会把刚弹出的 @ 菜单一起关掉，
  // 表现就是「文件列表出来一瞬间又没了」（实测：先打 / 再改成 @ 必现）。
  useEffect(() => {
    if (slashQuery === null) setDismissed(false)
    // 直接采用返回值：返回 null 就是「该关闭」，不能写 ?? current 兜底
    setMenu((current) => nextMenuForSlash(current, slashQuery, dismissed))
    if (slashQuery !== null && !dismissed) setActive(0)
  }, [slashQuery, dismissed])

  // 键盘切换时把当前项滚进可视区
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('.chat-slash-item.active')
    node?.scrollIntoView({ block: 'nearest' })
  }, [active, menu])

  /**
   * 父组件传进来的搜索回调每次渲染都可能换新函数；放进 ref，
   * 这样 effect 只依赖「菜单开着」和「查询词」，不会因为父组件重渲染反复发请求。
   */
  const findFilesRef = useRef(onFindFiles)
  findFilesRef.current = onFindFiles

  // 菜单开着时按查询词取候选；查询词变化后短暂防抖，避免每个字符打一次磁盘。
  useEffect(() => {
    if (menu !== 'files') return
    const query = mention?.query ?? ''
    let alive = true
    setFileLoading(true)
    const timer = setTimeout(() => {
      findFilesRef
        .current(query)
        .then((hits) => {
          if (alive) setFileHits(hits)
        })
        .catch(() => {
          if (alive) setFileHits([])
        })
        .finally(() => {
          if (alive) setFileLoading(false)
        })
    }, 90)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [menu, mention?.query])

  /**
   * 根据文本和光标判断是否处于 @ 提及中。
   *
   * 只有「用户自己打字/点选」才调用：程序化插入路径后调它会把刚插入的
   * `@src/a.ts` 又当成新提及，菜单自己弹回来。
   */
  function syncMention(value: string, caret: number | null) {
    const found = caret === null ? null : parseMentionAt(value, caret)
    // 只有「进入新提及」或「query 真的变了」才清候选。
    // 光标在同一段提及里来回移动（onSelect 会反复触发）时如果无条件清空，
    // 搜索 effect 的依赖 [menu, mention?.query] 没变、不会重新搜，列表就永久空白 ——
    // 用户看到的是「文件列表出来一瞬间又没了」（实测复现）。
    const started = shouldResetHits(found, mention)
    setMention(found)
    if (found) {
      setMenu('files')
      if (started) {
        setActive(0)
        setFileHits([])
      }
    } else if (menu === 'files') {
      setMenu(null)
    }
  }

  /** 选中一个候选：把 @query 换成 @路径，光标落到后面。目录则留在提及里继续补。 */
  function chooseFile(hit: MentionHit) {
    if (!mention) return
    const isDir = hit.type === 'directory'
    const applied = applyMention(draft, mention, hit.path, isDir)
    setFileHits([])
    onDraftChange(applied.text)
    if (isDir) {
      // 目录：提及还在（@src\components\），把状态同步成新的 query 好继续补
      const nextMention = parseMentionAt(applied.text, applied.caret)
      setMention(nextMention)
      setMenu(nextMention ? 'files' : null)
      setActive(0)
    } else {
      setMention(null)
      setMenu(null)
      setDismissed(true)
    }
    // 光标要落在插入内容之后：改完草稿再定位，否则会被受控组件的重渲染覆盖
    requestAnimationFrame(() => {
      const el = areaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(applied.caret, applied.caret)
    })
  }

  function focusInput() {
    requestAnimationFrame(() => {
      const el = areaRef.current
      if (!el) return
      el.focus()
      const end = el.value.length
      el.setSelectionRange(end, end)
    })
  }

  function chooseCommand(item: CommandItem) {
    if (item.disabled) {
      setNotice(
        item.note
          ? `/${item.name}：请用${item.note}`
          : `/${item.name} 仅在 TUI 可用`,
      )
      return
    }
    setNotice(null)
    if (item.builtin === 'agents') {
      setMenu('agents')
      setActive(0)
      return
    }
    setDismissed(true)
    setMenu(null)
    if (item.builtin) {
      onDraftChange('')
      onBuiltin(item.builtin)
      return
    }
    // 服务端命令：插入 /name，让用户补参数后再回车
    onDraftChange(`/${item.name} `)
    focusInput()
  }

  function chooseAgent(agent: AgentInfo) {
    setDismissed(true)
    setMenu(null)
    onDraftChange('')
    onPickAgent(agent.id)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menu === 'files') {
      const hits = filterHits(fileHits, mention?.query ?? '')
      // 菜单开着的时候，Enter 一律归菜单：候选为空也不能穿透去发送，
      // 否则「打了 @ 但没搜到文件」按回车的半句话直接被发出去（实测过的坑）。
      // 但 Shift+Enter 是换行，任何情况下都得放过去——否则「@ 打了字又搜不到」
      // 就变成既选不了、也换不了行（实测踩过）。
      if ((event.key === 'Enter' || event.key === 'Tab') && hits.length === 0) {
        if (!event.shiftKey) event.preventDefault()
        return
      }
      if (event.key === 'ArrowDown' && hits.length > 0) {
        event.preventDefault()
        setActive((current) => (current + 1) % hits.length)
        return
      }
      if (event.key === 'ArrowUp' && hits.length > 0) {
        event.preventDefault()
        setActive((current) => (current - 1 + hits.length) % hits.length)
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && hits.length > 0) {
        // Shift+Enter = 换行，不能拿去选候选
        if (event.shiftKey) return
        event.preventDefault()
        chooseFile(hits[Math.min(active, hits.length - 1)])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(null)
        setMenu(null)
        return
      }
      // 其余按键交给输入框：继续打字时 onChange 会重新解析提及
    }

    if (menu === 'commands' && filtered.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((current) => (current + 1) % filtered.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((current) => (current - 1 + filtered.length) % filtered.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        chooseCommand(filtered[Math.min(active, filtered.length - 1)])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissed(true)
        setMenu(null)
        return
      }
    }

    if (menu === 'agents' && agents.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((current) => (current + 1) % agents.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((current) => (current - 1 + agents.length) % agents.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        chooseAgent(agents[Math.min(active, agents.length - 1)])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenu('commands')
        setActive(0)
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSend()
    }
  }

  /** 选文件（点击「图片」按钮）。 */
  function pickFiles() {
    fileRef.current?.click()
  }

  function takeFiles(list: FileList | File[] | null | undefined) {
    const files: File[] = list ? Array.from(list) : []
    if (files.length === 0) return
    setNotice(null)
    onAddFiles(files)
  }

  /** 粘贴：剪贴板里带图片/文件时拦下来变成附件，纯文本照常进输入框。 */
  function onPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(event.clipboardData?.items ?? [])
    const files: File[] = []
    for (const item of items) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file) files.push(file)
    }
    if (files.length === 0) return
    event.preventDefault()
    takeFiles(files)
  }

  function onDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }

  function onDragLeave(event: React.DragEvent<HTMLDivElement>) {
    // 移到子元素上也会触发 dragleave，只认真正离开整个输入区
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDragging(false)
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer?.files?.length) return
    event.preventDefault()
    setDragging(false)
    takeFiles(event.dataTransfer.files)
  }

  return (
    <div
      className={`chat-input-wrap${dragging ? ' dragging' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/*,.pdf,.txt,.md,.json,.log"
        multiple
        hidden
        onChange={(event) => {
          takeFiles(event.target.files)
          // 清掉 value，同一个文件再选一次也能触发 change
          event.target.value = ''
        }}
      />
      {menu ? (
        <div className={menu === 'files' ? 'chat-slash-menu files' : 'chat-slash-menu'}>
          {menu === 'files' ? (
            <div className="chat-slash-list" ref={listRef}>
              {fileLoading && fileHits.length === 0 ? (
                <div className="chat-slash-empty">搜索文件…</div>
              ) : filterHits(fileHits, mention?.query ?? '').length === 0 ? (
                <div className="chat-slash-empty">
                  {mention?.query ? `没有匹配 ${mention.query} 的文件` : '当前目录没有可引用的文件'}
                </div>
              ) : (
                filterHits(fileHits, mention?.query ?? '').map((hit, index) => (
                  <button
                    key={hit.path}
                    type="button"
                    className={`chat-slash-item${index === active ? ' active' : ''}`}
                    title={hit.type === 'directory' ? `${hit.path}（目录，可继续往下选）` : hit.path}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      chooseFile(hit)
                    }}
                  >
                    <span className="chat-slash-name">
                      {baseName(hit.path)}
                      {hit.type === 'directory' ? '\\' : ''}
                    </span>
                    <span className="chat-slash-desc"><bdi>{dirName(hit.path)}</bdi></span>
                  </button>
                ))
              )}
            </div>
          ) : menu === 'agents' ? (
            <>
              <button
                type="button"
                className="chat-slash-back"
                onClick={() => {
                  setMenu('commands')
                  setActive(0)
                }}
              >
                ← 返回命令
              </button>
              <div className="chat-slash-head">选择 agent</div>
              <div className="chat-slash-list" ref={listRef}>
                {agents.length === 0 ? (
                  <div className="chat-slash-empty">没有可用 agent</div>
                ) : (
                  agents.map((agent, index) => (
                    <button
                      key={agent.id}
                      type="button"
                      className={`chat-slash-item${index === active ? ' active' : ''}`}
                      title={agent.description ?? agent.id}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        chooseAgent(agent)
                      }}
                    >
                      <span className="chat-slash-name">{agent.name ?? agent.id}</span>
                      <span className="chat-slash-desc">{agent.description ?? ''}</span>
                    </button>
                  ))
                )}
              </div>
            </>
          ) : (
            <div className="chat-slash-list" ref={listRef}>
              {filtered.length === 0 ? (
                <div className="chat-slash-empty">没有匹配的命令</div>
              ) : (
                filtered.map((item, index) => (
                  <button
                    key={`${item.group}:${item.name}`}
                    type="button"
                    className={`chat-slash-item${index === active ? ' active' : ''}${
                      item.disabled ? ' disabled' : ''
                    }`}
                    title={item.description ?? item.name}
                    aria-disabled={item.disabled || undefined}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      chooseCommand(item)
                    }}
                  >
                    <span className="chat-slash-name">/{item.name}</span>
                    <span className="chat-slash-desc">{item.description ?? ''}</span>
                    {item.disabled ? (
                      <span className="chat-slash-badge">{item.note ?? '仅 TUI'}</span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          )}
          {notice ? <div className="chat-slash-notice">{notice}</div> : null}
        </div>
      ) : null}

      {attachments.length > 0 ? (
        <div className="chat-attach-row">
          {attachments.map((file) => (
            <div
              className="chat-attach"
              key={file.id}
              title={`${file.name} · ${formatBytes(file.bytes)}`}
            >
              {isImageMime(file.mime) ? (
                <img className="chat-attach-thumb" src={file.previewUrl} alt={file.name} />
              ) : (
                <span className="chat-attach-name">{file.name}</span>
              )}
              <button
                type="button"
                className="chat-attach-remove"
                title="移除"
                aria-label={`移除 ${file.name}`}
                onClick={() => onRemoveAttachment(file.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {notice && !menu ? <div className="chat-attach-notice">{notice}</div> : null}

      {/* 统计条放在输入框上方：输入框要贴到面板最底部（用户明确要求） */}
      {footer}

      <div className="chat-input-row">
        <textarea
          ref={areaRef}
          className="chat-input"
          rows={2}
          value={draft}
          onChange={(event) => {
            setDismissed(false)
            setNotice(null)
            onDraftChange(event.target.value)
            // 用事件里的光标位置判断 @ 提及：受控组件的 value 还没回流到 DOM，
            // 直接读 el.selectionStart 可能是上一轮的位置
            syncMention(event.target.value, event.target.selectionStart)
          }}
          onSelect={(event) => {
            // 点选/方向键移动光标后也要重新判断：光标可能已经离开提及范围
            const el = event.currentTarget
            if (el.selectionStart === el.selectionEnd) {
              syncMention(el.value, el.selectionStart)
            }
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={
            connected
              ? compactHint
                ? '输入消息，Enter 发送，/ 命令'
                : '输入消息，Enter 发送，Shift+Enter 换行；/ 命令，@ 引用文件'
              : '后端未连接'
          }
          disabled={!connected}
        />
        <div className="chat-input-tools">
          <button
            type="button"
            className="chat-attach-add"
            onClick={pickFiles}
            title="添加图片/文件；也可以直接粘贴截图或拖进来"
            aria-label="添加图片或文件"
            disabled={!connected}
          >
            <Icon name="attach" size={15} />
            <span className="chat-tool-text">图片</span>
          </button>
          {onUndo ? (
            <button
              type="button"
              className="chat-undo"
              onClick={onUndo}
              disabled={undoDisabled}
              title={undoTitle ?? '把最近一轮的代码改动撤回（可再取消）'}
            >
              <Icon name="refresh" size={14} />
              <span className="chat-tool-text">回到上一版</span>
            </button>
          ) : null}
          {onHistory ? (
            <button
              type="button"
              className="chat-undo"
              onClick={onHistory}
              disabled={historyDisabled}
              title={historyTitle ?? '查看最近的修改节点，先审核再回到某一版'}
            >
              <Icon name="review" size={14} />
              <span className="chat-tool-text">修改记录</span>
            </button>
          ) : null}
          <div className="chat-input-actions">
            {running ? (
              <>
                <button
                  type="button"
                  className="chat-send ghost"
                  onClick={onBackground}
                  title="把正在跑的命令挪到后台，立刻解锁继续输入（Ctrl+B）"
                >
                  后台
                </button>
                <button type="button" className="chat-send stop" onClick={onStop} title="停止生成">
                  <Icon name="stop" size={12} />
                  停止
                </button>
              </>
            ) : (
              <button
                type="button"
                className="chat-send"
                onClick={onSend}
                disabled={!canSend}
                title="发送（Enter）"
              >
                <Icon name="send" size={14} />
                {busy ? '发送中' : '发送'}
              </button>
            )}
          </div>
        </div>
      </div>

    </div>
  )
}
