import { useMemo, useState } from 'react'
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
              <div className="chat-bubble">{turn.user}</div>
            </div>
          ) : null}

          {turn.texts.length > 0 ? (
            <div className="chat-msg assistant">
              <div className="chat-bubble">{turn.texts.join('\n\n')}</div>
            </div>
          ) : null}

          <ToolGroup tools={turn.tools} />
        </div>
      ))}
    </>
  )
}
