/**
 * 「修改记录」：把会话里的用户消息整理成可回溯的修改节点。
 *
 * 每个节点 = 一轮（用户发一句话 → 模型改一轮文件）。服务端能按用户消息 id
 * 取那一轮的逐文件 diff（`/api/session/{id}/diff?from=<id>`，只读、不动磁盘），
 * 所以「审核」和「回溯」是分开的两步：先看清楚改了什么，再决定回不回。
 */
import type { ChatMessage, MessageFile } from '../api/chat'

/** 面板上最多列多少个节点。再多也没人翻，而且每个都要打一次 diff 请求。 */
export const MAX_NODES = 10

export type RevertNode = {
  /** 用户消息 id，回撤边界就是它 */
  messageID: string
  /** 用户当时的原话（可能为空：纯附件提问） */
  text: string
  /** 这条消息带的附件（回撤时一起放回输入框） */
  files: MessageFile[]
  /** 序号：1 = 最早的，越大越新。给人看「第几轮」 */
  index: number
  /** 距现在的轮数：0 = 最近一轮 */
  age: number
  /** 提问时间（毫秒），没有就不显示时间 */
  at?: number
}

/**
 * 从消息列表里取最近 `limit` 个修改节点。
 *
 * `messages` 是服务端顺序（最新在前），所以这里倒着扫、取到第一条用户消息
 * 就是最近的一轮。返回值保持「最新在前」，和消息流的方向一致。
 *
 * 只认 `type: 'user'`：助手回复、idle 标记、压缩摘要都不是「一次修改」的起点。
 */
export function buildRevertNodes(
  messages: ChatMessage[],
  limit = MAX_NODES,
): RevertNode[] {
  if (limit <= 0) return []
  // 先按时间正序排一遍（服务端给的是倒序），这样 index 才符合人对「第几轮」的直觉
  const all = messages.filter((message) => message.type === 'user')
  const total = all.length
  const picked = all.slice(0, limit)
  return picked.map((message, offset) => ({
    messageID: message.id,
    text: message.text ?? '',
    files: message.files ?? [],
    index: total - offset,
    age: offset,
    at: message.time?.created,
  }))
}

/**
 * 节点的一句摘要：把用户原话压成一行，没有文字就说明是附件。
 *
 * 用在列表项上，不能太长——一行的空间只够十几个字，超了会被 CSS 省略。
 */
export function nodeSummary(node: RevertNode): string {
  const text = node.text.replace(/\s+/g, ' ').trim()
  if (text) return text
  if (node.files.length > 0) return `（${node.files.length} 个附件）`
  return '（空消息）'
}

/** 文件改动的合计：`12 个文件 +340 -87`。没有改动时说清楚。 */
export function filesSummary(files: { additions: number; deletions: number }[]): string {
  if (files.length === 0) return '没有文件改动'
  let add = 0
  let del = 0
  for (const file of files) {
    add += file.additions
    del += file.deletions
  }
  return `${files.length} 个文件 +${add} -${del}`
}
