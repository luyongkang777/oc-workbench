import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import MarkdownText, { type OpenFile } from './MarkdownText'
import { copyText } from './clipboard'
import { isImageFile, messageFilePreview } from './attachments'
import { parseFilePath } from './fileLinks'
import { groupTurns, reasoningLabel, type ToolInfo, type Turn, type TurnBlock } from './turns'
import type { ChatMessage, MessageFile } from '../api/chat'

function summarize(tools: ToolInfo[]): string {
  const counts = new Map<string, number>()
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
    .join(' · ')
}

function ToolRow({ tool, onOpenFile }: { tool: ToolInfo; onOpenFile?: OpenFile }) {
  const tone =
    tool.status === 'completed'
      ? 'done'
      : tool.status === 'running' || tool.status === 'pending'
        ? 'run'
        : 'fail'
  // 工具详情经常就是文件路径（read / edit 的入参），能认出来就点开
  const file = onOpenFile ? parseFilePath(tool.detail) : null
  return (
    <div className={`chat-tool-row ${tone}`}>
      <span className="chat-tool-name">{tool.name}</span>
      {file && onOpenFile ? (
        <button
          type="button"
          className="chat-tool-detail chat-tool-file"
          title={`在编辑器打开 ${file.path}${file.line ? ` 第 ${file.line} 行` : ''}`}
          onClick={() => onOpenFile(file.path, file.line)}
        >
          {tool.detail}
        </button>
      ) : (
        <span className="chat-tool-detail" title={tool.detail}>
          {tool.detail}
        </span>
      )}
      <span className="chat-tool-status">{tool.status}</span>
    </div>
  )
}

function ToolGroup({ tools, onOpenFile }: { tools: ToolInfo[]; onOpenFile?: OpenFile }) {
  const [open, setOpen] = useState(false)
  if (tools.length === 0) return null

  return (
    <div className="chat-tools">
      <button type="button" className="chat-tools-summary" onClick={() => setOpen((v) => !v)}>
        <span className="chat-tools-caret">{open ? '▾' : '▸'}</span>
        <span>使用了 {tools.length} 个工具</span>
        <span className="chat-tools-kinds">{summarize(tools)}</span>
      </button>
      {open ? (
        <div className="chat-tools-list">
          {tools.map((tool, index) => (
            <ToolRow tool={tool} onOpenFile={onOpenFile} key={`${tool.name}-${index}`} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * 一段思考。每段独立成块 —— 第一次思考结束就落位，说过话、调过工具之后的第二次思考
 * 另起一块往下排，不再把所有 reasoning 拼成一大坨。
 */
function ReasoningBlock({ block }: { block: Extract<TurnBlock, { kind: 'reasoning' }> }) {
  const [manual, setManual] = useState<boolean | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // 这一段开始推理：恢复自动展开
  useEffect(() => {
    if (block.active) setManual(null)
  }, [block.active])

  useEffect(() => {
    if (!block.active) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [block.active])

  const open = manual === null ? block.active : manual
  const label = reasoningLabel(
    { reasoningActive: block.active, reasoningMs: block.ms, reasoningStartedAt: block.startedAt },
    now,
  )

  return (
    <div className={`chat-reasoning${block.active ? ' active' : ''}`}>
      <button type="button" className="chat-reasoning-head" onClick={() => setManual(!open)}>
        <span className="chat-reasoning-caret">{open ? '▾' : '▸'}</span>
        <span className="chat-reasoning-label">{label}</span>
        <span className="chat-reasoning-hint">{block.active ? '模型正在推理' : '点击查看'}</span>
      </button>
      {open ? (
        <div className="chat-reasoning-body">
          {block.text ? block.text : <span className="chat-reasoning-wait">等待思考内容…</span>}
        </div>
      ) : null}
    </div>
  )
}

/** 复制文本：优先 Clipboard API，失败退回 execCommand（WebView2 里两条路都能用）。 */
/** 气泡右下角的复制按钮，成功后 1.2 秒内显示「已复制」。 */
function CopyButton({ text, title }: { text: string; title: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'fail'>('idle')
  const timer = useRef<number | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [])

  // 流式输出时 text 会继续变化，上一轮的「已复制」不能贴到新内容上
  useEffect(() => setState('idle'), [text])

  async function onClick() {
    const ok = await copyText(text)
    if (!alive.current) return
    setState(ok ? 'done' : 'fail')
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      if (alive.current) setState('idle')
    }, 1200)
  }

  const label = state === 'done' ? '已复制' : state === 'fail' ? '复制失败' : title

  return (
    <button
      type="button"
      className={`chat-copy ${state}`}
      aria-label={label}
      title={title}
      onClick={() => void onClick()}
    >
      {state === 'done' ? '已复制' : state === 'fail' ? '失败' : '复制'}
    </button>
  )
}
type CopyMenuState = {
  x: number
  y: number
  text: string
  done: boolean
}

/** 用户消息里的附件：图片显示缩略图，其它文件显示文件名小条。 */
function FileGrid({
  files,
  onOpen,
}: {
  files: MessageFile[]
  onOpen: (url: string, name: string) => void
}) {
  if (files.length === 0) return null
  return (
    <div className="chat-files">
      {files.map((file, index) => {
        const url = messageFilePreview(file)
        if (url) {
          return (
            <button
              key={`f-${index}`}
              type="button"
              className="chat-file-img"
              title={`${file.name ?? '图片'}（点击放大）`}
              onClick={() => onOpen(url, file.name ?? `图片${index + 1}`)}
            >
              <img src={url} alt={file.name ?? ''} loading="lazy" />
            </button>
          )
        }
        return (
          <span className="chat-file-chip" key={`f-${index}`} title={file.name ?? file.mime ?? '附件'}>
            <span className="chat-file-chip-icon">{isImageFile(file) ? '图' : '文'}</span>
            <span className="chat-file-chip-name">{file.name ?? file.mime ?? '附件'}</span>
          </span>
        )
      })}
    </div>
  )
}

/** 点图放大：整屏遮罩，点任意处或 Esc 关闭。 */
function Lightbox({ image, onClose }: { image: { url: string; name: string } | null; onClose: () => void }) {
  useEffect(() => {
    if (!image) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [image, onClose])

  if (!image) return null
  return (
    <div className="chat-lightbox" role="dialog" aria-label={image.name} onClick={onClose}>
      <img src={image.url} alt={image.name} onClick={(event) => event.stopPropagation()} />
      <button type="button" className="chat-lightbox-close" onClick={onClose}>
        关闭
      </button>
    </div>
  )
}

export default function MessageList({
  messages,
  running = false,
  root,
  onOpenFile,
}: {
  messages: ChatMessage[]
  running?: boolean
  /** 工作区根：Markdown 里的本地图片要按它转相对路径 */
  root?: string
  /** 点消息里的文件路径 → 中间栏打开（可选，不传就当普通文本） */
  onOpenFile?: OpenFile
}) {
  const turns = useMemo(() => groupTurns(messages), [messages])
  const [menu, setMenu] = useState<CopyMenuState | null>(null)
  const [lightbox, setLightbox] = useState<{ url: string; name: string } | null>(null)
  const menuTimer = useRef<number | null>(null)
  const closeLightbox = useRef(() => setLightbox(null)).current

  // 首字还没到（assistant 消息都还没建）时先给一个「思考中」，别让界面像卡住
  const last = turns[turns.length - 1]
  const waiting = running && (!last || last.blocks.length === 0)

  // 点别处、滚动、按 Esc 都关掉右键菜单
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  useEffect(() => () => {
    if (menuTimer.current) window.clearTimeout(menuTimer.current)
  }, [])

  function openMenu(e: ReactMouseEvent, text: string) {
    // 已经选中一段文字时保留浏览器原生菜单，别抢走「复制选区」
    if ((window.getSelection()?.toString() ?? '').trim()) return
    e.preventDefault()
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 148),
      y: Math.min(e.clientY, window.innerHeight - 44),
      text,
      done: false,
    })
  }

  async function copyFromMenu() {
    if (!menu) return
    const ok = await copyText(menu.text)
    if (!ok) {
      setMenu(null)
      return
    }
    setMenu((current) => (current ? { ...current, done: true } : current))
    menuTimer.current = window.setTimeout(() => setMenu(null), 600)
  }

  if (turns.length === 0) {
    return <div className="chat-placeholder">{running ? '模型思考中…' : '还没有消息，直接在下面输入'}</div>
  }

  return (
    <>
      {turns.map((turn) => (
        <div className="chat-turn" key={turn.id}>
          {turn.user !== undefined || turn.files.length > 0 ? (
            <div className="chat-msg user">
              <div
                className="chat-bubble-wrap"
                onContextMenu={(e) => openMenu(e, turn.user ?? '')}
              >
                <div className="chat-bubble">
                  <FileGrid
                    files={turn.files}
                    onOpen={(url, name) => setLightbox({ url, name })}
                  />
                  {turn.user ? turn.user : null}
                </div>
                {turn.user ? <CopyButton text={turn.user} title="复制这条提问" /> : null}
              </div>
            </div>
          ) : null}

          {turn.blocks.map((block) => {
            if (block.kind === 'reasoning') {
              return <ReasoningBlock block={block} key={block.key} />
            }
            if (block.kind === 'tools') {
              return <ToolGroup tools={block.tools} onOpenFile={onOpenFile} key={block.key} />
            }
            return (
              <div className="chat-msg assistant" key={block.key}>
                <div className="chat-bubble-wrap" onContextMenu={(e) => openMenu(e, block.text)}>
                  <div className="chat-bubble">
                    <MarkdownText text={block.text} root={root} onOpenFile={onOpenFile} />
                  </div>
                  <CopyButton text={block.text} title="复制这条回复（Markdown 原文）" />
                </div>
              </div>
            )
          })}
        </div>
      ))}

      <Lightbox image={lightbox} onClose={closeLightbox} />

      {waiting ? (
        <div className="chat-waiting">
          <span className="chat-waiting-dot" />
          模型思考中…
        </div>
      ) : null}

      {menu ? (
        <div
          className="chat-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" className="chat-menu-item" onClick={() => void copyFromMenu()}>
            {menu.done ? '已复制' : '复制这条消息'}
          </button>
        </div>
      ) : null}
    </>
  )
}
