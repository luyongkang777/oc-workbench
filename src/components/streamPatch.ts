/**
 * 流式增量补丁：用事件里带的数据直接改本地消息，不重新拉整包。
 *
 * 背景：一轮对话的消息接口是全量返回，大会话一次 6MB+。原来每来一个事件就重拉
 * 一遍，聊天越久越卡。这里的做法是——
 *   step.started  → 本地先插一条占位消息
 *   text.delta    → 直接往这条消息对应的 text 段追加
 *   text.ended    → 用完整文本覆盖一遍校对
 *   step.ended    → 上层再拉一次全量对账（拿到 token、耗时等元信息）
 *
 * 全是纯函数，输入输出都是新数组，不改原对象。
 */
import type { ChatMessage, MessagePart } from '../api/chat'

/** 在 content 里找第 ordinal 个 text 段；不够长就补齐。 */
function withTextAt(parts: MessagePart[], ordinal: number, text: string): MessagePart[] {
  const next = parts.map((p) => ({ ...p }))
  let seen = -1
  for (let i = 0; i < next.length; i++) {
    if (next[i].type !== 'text') continue
    seen += 1
    if (seen === ordinal) {
      next[i] = { ...next[i], text }
      return next
    }
  }
  // 还没有这一段：补一个（中间缺的用空文本占位，保证 ordinal 对得上）
  while (seen < ordinal) {
    seen += 1
    if (seen === ordinal) next.push({ type: 'text', text })
    else next.push({ type: 'text', text: '' })
  }
  return next
}

/** 读第 ordinal 个 text 段的当前内容。 */
function textAt(parts: MessagePart[], ordinal: number): string {
  let seen = -1
  for (const part of parts) {
    if (part.type !== 'text') continue
    seen += 1
    if (seen === ordinal) return part.text ?? ''
  }
  return ''
}

/**
 * 确保这条消息在列表里。没有就插到最前面 —— 列表约定是最新在前。
 * seed 用来带上 agent/model 这类骨架信息。
 */
export function ensureMessage(
  messages: ChatMessage[],
  id: string,
  seed?: Partial<ChatMessage>,
): ChatMessage[] {
  if (messages.some((m) => m.id === id)) return messages
  return [{ type: 'assistant', content: [], ...seed, id }, ...messages]
}

/** 追加一段流式文本。消息不存在时原样返回（等 step.started 建骨架）。 */
export function appendText(
  messages: ChatMessage[],
  id: string,
  ordinal: number,
  delta: string,
): ChatMessage[] {
  if (!delta) return messages
  let changed = false
  const next = messages.map((m) => {
    if (m.id !== id) return m
    const parts = Array.isArray(m.content) ? m.content : []
    const current = textAt(parts, ordinal)
    changed = true
    return { ...m, content: withTextAt(parts, ordinal, current + delta) }
  })
  return changed ? next : messages
}

/** 用完整文本覆盖（text.ended 时用来校对，防止增量丢字）。 */
export function setText(
  messages: ChatMessage[],
  id: string,
  ordinal: number,
  text: string,
): ChatMessage[] {
  let changed = false
  const next = messages.map((m) => {
    if (m.id !== id) return m
    const parts = Array.isArray(m.content) ? m.content : []
    if (textAt(parts, ordinal) === text) return m
    changed = true
    return { ...m, content: withTextAt(parts, ordinal, text) }
  })
  return changed ? next : messages
}

/** 这一轮结束了：给消息打上完成时间，思考中的指示就能收起来。 */
export function finishMessage(
  messages: ChatMessage[],
  id: string,
  completed: number,
): ChatMessage[] {
  return messages.map((m) =>
    m.id === id ? { ...m, time: { ...(m.time ?? {}), completed } } : m,
  )
}
