import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentInfo } from '../api/chat'
import { formatBytes } from './codeWindow'
import { isImageMime, type ChatAttachment } from './attachments'
import { filterCommands, type CommandItem } from './chatCommands'

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
  onBuiltin: (name: string) => void
  onPickAgent: (id: string) => void
  onAddFiles: (files: File[]) => void
  onRemoveAttachment: (id: string) => void
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
  onBuiltin,
  onPickAgent,
  onAddFiles,
  onRemoveAttachment,
}: Props) {
  const [menu, setMenu] = useState<'commands' | 'agents' | null>(null)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const canSend = connected && !busy && (draft.trim().length > 0 || attachments.length > 0)

  const slashQuery = /^\/([^\s]*)$/.exec(draft)?.[1] ?? null
  const filtered = useMemo(
    () => filterCommands(commands, slashQuery ?? ''),
    [commands, slashQuery],
  )

  // 只有在「输入以 / 开头且还没空格」时才进入选择模式；Esc 关闭后不再自动弹回
  useEffect(() => {
    if (slashQuery === null) {
      setMenu(null)
      setDismissed(false)
      return
    }
    if (dismissed) {
      setMenu(null)
      return
    }
    setMenu((current) => (current === 'agents' && slashQuery === 'agents' ? 'agents' : 'commands'))
    setActive(0)
  }, [slashQuery, dismissed])

  // 键盘切换时把当前项滚进可视区
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('.chat-slash-item.active')
    node?.scrollIntoView({ block: 'nearest' })
  }, [active, menu])

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
        <div className="chat-slash-menu">
          {menu === 'agents' ? (
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

      <div className="chat-input-row">
        <button
          type="button"
          className="chat-attach-add"
          onClick={pickFiles}
          title="选择图片/文件；也可以直接粘贴截图或拖进来"
          disabled={!connected}
        >
          ＋图片
        </button>
        <textarea
          ref={areaRef}
          className="chat-input"
          value={draft}
          onChange={(event) => {
            setDismissed(false)
            setNotice(null)
            onDraftChange(event.target.value)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={
            connected
              ? '输入消息，Enter 发送，Shift+Enter 换行；/ 打开命令；可直接粘贴或拖入图片'
              : '后端未连接'
          }
          disabled={!connected}
        />
        {running ? (
          <button type="button" className="chat-send stop" onClick={onStop} title="停止生成">
            停止
          </button>
        ) : (
          <button type="button" className="chat-send" onClick={onSend} disabled={!canSend}>
            {busy ? '发送中' : '发送'}
          </button>
        )}
      </div>
    </div>
  )
}
