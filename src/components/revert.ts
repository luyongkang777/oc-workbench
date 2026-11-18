/**
 * 回撤（revert）的纯计算：哪些消息该显示、回撤的原文怎么放回输入框。
 *
 * 和服务端的语义对齐（2026-11 实测，opencode 2.3）：
 *   - `stage` 只是把「从 messageID 开始」标成待回滚，消息还在库里，可以 clear 取消；
 *   - `commit` 才真正删掉这条及其之后的消息；
 *   - 用户重新发消息时服务端也会自动 commit。
 *   - `stage` 带 `files: true` 时**当场**把磁盘文件还原成那条消息之前的样子，
 *     点「取消回撤」又会退回改动后的状态 —— 所以这一步可以放心地点。
 *
 * 所以界面在 stage 之后要自己截断显示，否则点了「回撤」看上去什么都没发生。
 */
import type { ChatMessage } from '../api/chat'

/**
 * 截掉回撤边界及其之后的消息。
 *
 * `messages` 是服务端顺序（最新在前）。找不到边界消息时原样返回：
 * 那种情况通常是「回撤已经被 commit 掉了」，此时库里已经没有需要隐藏的内容，
 * 再截一次会把整段历史藏起来。
 */
export function sliceAtRevert(
  messages: ChatMessage[],
  boundaryID?: string | null,
): ChatMessage[] {
  if (!boundaryID) return messages
  const index = messages.findIndex((message) => message.id === boundaryID)
  if (index < 0) return messages
  return messages.slice(index + 1)
}

/** 边界消息是否真的在本地消息里（用于判断这次回撤还有没有意义）。 */
export function hasBoundary(messages: ChatMessage[], boundaryID?: string | null): boolean {
  if (!boundaryID) return false
  return messages.some((message) => message.id === boundaryID)
}

/**
 * 把回撤的原文放回输入框。
 *
 * 输入框本来就有字时不能直接覆盖：那可能是用户打到一半的另一件事。
 * 两份内容都留着（回撤原文在前，原草稿在后），让用户自己删。
 */
export function joinRevertedDraft(reverted: string, draft: string): string {
  const origin = draft.trim()
  const text = reverted.trim()
  if (!origin) return reverted
  if (!text) return draft
  return `${reverted}\n\n${draft}`
}

/** 回撤提示条的文案：说清「现在还没有真删」和「发送后才生效」。 */
export function revertNoticeText(): string {
  return '已回撤到这条消息，改完可直接重新发送'
}

/**
 * 找「回到上一版」该落在哪条消息上。
 *
 * `messages` 是服务端顺序（最新在前）。取**最近一条用户消息**：
 * 它就是最后一次让模型动手的那句命令，回撤到它之前，等于把那一轮
 * （含它产生的所有代码改动）一起撤销。
 *
 * 边界不能选最新的 assistant 消息：那样会留下这一轮的提问，用户看到的是
 * 「命令还在、结果没了」，容易误以为文件也被删了。
 *
 * 没有用户消息（空会话 / 只有系统消息）时返回 null，按钮据此置灰。
 */
export function lastUserBoundary(messages: ChatMessage[]): ChatMessage | null {
  for (const message of messages) {
    if (message.type === 'user') return message
  }
  return null
}
