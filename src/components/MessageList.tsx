import { useEffect, useMemo, useRef, useState } from 'react'
import MarkdownText from './MarkdownText'
import type { ChatMessage, MessagePart } from '../api/chat'

type ToolInfo = {
  name: string
  status: string
  detail: string
}

type Turn = {
  id: string
  user?: string
  texts: string[]
  tools: ToolInfo[]
}

const DETAIL_LIMIT = 90

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > DETAIL_LIMIT ? `${one.slice(0, DETAIL_LIMIT)}…` : one
}

function toolDetail(part: MessagePart): string {
  const input = (part.state as { input?: Record<string, unknown> } | undefined)?.input ?? {}
  const pick = (key: string): string => {
    const value = input[key]
    return typeof value === 'string' ? value : ''
  }
  const raw =
    pick('command') ||
    pick('filePath') ||
    pick('path') ||
    pick('pattern') ||
    pick('query') ||
    pick('url') ||
    pick('code') ||
    ''
  return clip(raw)
}

/**
 * 把消息按「用户提问」切成一轮一轮。
 *
 * opencode 的消息接口是**倒序**返回的（最新在前），这里先反转成时间正序，
 * 否则界面上会出现「回复在上、提问在下」。
 */
export function groupTurns(messages: ChatMessage[]): Turn[] {
  const ordered = [...messages].reverse()
  const turns: Turn[] = []

  for (const message of ordered) {
    if (message.type === 'idle') continue

    if (message.type === 'user') {
      turns.push({ id: message.id, user: message.text ?? '', texts: [], tools: [] })
      continue
    }

    if (message.type !== 'assistant') continue

    let turn = turns[turns.length - 1]
    if (!turn || turn.user === undefined) {
      // 开头没有用户消息（例如历史被截断）时补一个空轮次，别把内容丢掉
      turn = { id: message.id, texts: [], tools: [] }
      turns.push(turn)
    }

    for (const part of message.content ?? []) {
      if (part.type === 'text' && part.text) {
        turn.texts.push(part.text)
      } else if (part.type === 'tool') {
        turn.tools.push({
          name: part.name ?? '工具',
          status: part.state?.status ?? 'unknown',
          detail: toolDetail(part),
        })
      }
    }
  }

  return turns
}

function summarize(tools: ToolInfo[]): string {
  const counts = new Map<string, number>()
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
    .join(' · ')
}

function ToolRow({ tool }: { tool: ToolInfo }) {
  const tone = tool.status === 'completed' ? 'done' : tool.status === 'running' ? 'run' : 'fail'
  return (
    <div className={`chat-tool-row ${tone}`}>
      <span className="chat-tool-name">{tool.name}</span>
      <span className="chat-tool-detail" title={tool.detail}>
        {tool.detail}
      </span>
      <span className="chat-tool-status">{tool.status}</span>
    </div>
  )
}

function ToolGroup({ tools }: { tools: ToolInfo[] }) {
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
            <ToolRow tool={tool} key={`${tool.name}-${index}`} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 复制文本：优先 Clipboard API，失败退回 execCommand（WebView2 里两条路都能用）。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 权限被拒时走下面的兜底
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/** 气泡右上角的复制按钮，成功后 1.2 秒内显示「已复制」。 */
function CopyButton({ text, title }: { text: string; title: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'fail'>('idle')
  const timer = useRef<number | null>(null)

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  async function onClick() {
    const ok = await copyText(text)
    setState(ok ? 'done' : 'fail')
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), 1200)
  }

  return (
    <button
      type="button"
      className={`chat-copy ${state}`}
      title={title}
      onClick={() => void onClick()}
    >
      {state === 'done' ? '已复制' : state === 'fail' ? '复制失败' : '复制'}
    </button>
  )
}
export default function MessageList({ messages }: { messages: ChatMessage[] }) {
  const turns = useMemo(() => groupTurns(messages), [messages])

  if (turns.length === 0) {
    return <div className="chat-placeholder">还没有消息，直接在下面输入</div>
  }

  return (
    <>
      {turns.map((turn) => (
        <div className="chat-turn" key={turn.id}>
          {turn.user ? (
            <div className="chat-msg user">
              <div className="chat-bubble-wrap">
                <div className="chat-bubble">{turn.user}</div>
                <CopyButton text={turn.user} title="复制这条提问" />
              </div>
            </div>
          ) : null}

          {turn.texts.length > 0 ? (
            <div className="chat-msg assistant">
              <div className="chat-bubble-wrap">
                <div className="chat-bubble">
                  <MarkdownText text={turn.texts.join('\n\n')} />
                </div>
                <CopyButton text={turn.texts.join('\n\n')} title="复制这条回复（Markdown 原文）" />
              </div>
            </div>
          ) : null}

          <ToolGroup tools={turn.tools} />
        </div>
      ))}
    </>
  )
}
