/**
 * 一轮对话「是否卡在失败态」的纯判定。
 *
 * 服务端把模型调用失败写成一条 `type: 'idle'` 的消息，带
 * `outcome: 'failed'` 和 `error`。工作台以前整条跳过这类消息
 * （`turns.ts` 里 `if (message.type === 'idle') continue`），
 * 于是界面上就是「发出去之后永远没有回复」——用户只能自己重发。
 *
 * 这里把「最新一轮到底失败了还是成功了」算清楚，交给重试编排决定要不要
 * 再投一次。判据全部基于消息列表本身，跟事件流无关（事件可能漏、可能断），
 * 所以重连后重新拉一次消息也能得出同样的结论。
 *
 * 纯函数，不碰 React / window（单测见 scripts/chatAutoRetry.test.mjs）。
 *
 * 注意别写成 `[...messages].reverse()`：这个函数在流式输出期间每秒会被调
 * 几十次，长会话几万条消息时整表复制+反转本身就是卡顿来源。消息接口是
 * 倒序的（最新在前），直接从 0 往后扫到最近一条用户消息即可，天然只看最后
 * 一轮。
 */
import type { ChatMessage } from '../api/chat'
import type { StructuredFailure } from './retryPolicy'

/** 一次待重试的失败。 */
export type PendingRetry = {
  /** 触发这一轮的用户消息 id：重投时要原样带回去（服务端按 id 幂等） */
  userMessageID: string
  /** 用户原文，重投要用 */
  text: string
  /** 用户带的附件 */
  files: NonNullable<ChatMessage['files']>
  /** 这已经是第几次失败（= 这轮失败了几次） */
  attempts: number
  /** 最后一次失败的结构化原因 */
  failure: StructuredFailure
}

/**
 * 一条 assistant 消息算不算「这一轮已经有输出了」。
 *
 * 有正文、有思考、有工具调用，或者已经写了 `time.completed` 都算。
 * 只看 `content.length > 0` 不够：工具调用失败留下的空 content 也会占位。
 */
function hasOutput(message: ChatMessage): boolean {
  if (message.type !== 'assistant') return false
  if (typeof message.time?.completed === 'number') return true
  const parts = Array.isArray(message.content) ? message.content : []
  return parts.length > 0
}

/**
 * 最新一轮是否停在失败态、以及已经失败了几次。
 *
 * 返回 null 的四种情况：
 *   - 还没有用户消息（空会话 / 刚清空）；
 *   - 这一轮已经有 assistant 输出（说明跑通了，或者正在跑）；
 *   - 没有失败记录（正常进行中）；
 *   - 最新的 idle 是 `succeeded` / `interrupted`（成功或被用户停掉，不是故障）。
 *
 * `attempts` 取「最新一条用户消息之后」的失败次数，所以重投一次就 +1，
 * 天然对得上重试上限，不需要额外记账（记账在刷新/切会话后还会丢）。
 */
export function pendingRetry(messages: ChatMessage[]): PendingRetry | null {
  if (!Array.isArray(messages) || messages.length === 0) return null

  // 从最新往旧扫，遇到用户消息就停：再往前的属于上一轮，不该重投
  let failures = 0
  let lastFailure: StructuredFailure | null = null
  let lastOutcome: string | undefined
  let userIndex = -1

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (!message) continue

    if (message.type === 'user') {
      userIndex = i
      break
    }
    // 已经有输出了：这一轮跑起来了，不算失败
    if (hasOutput(message)) return null
    if (message.type !== 'idle') continue

    lastOutcome = message.outcome
    if (message.outcome !== 'failed') continue
    failures += 1
    if (!lastFailure && message.error) {
      lastFailure = {
        type: message.error.type,
        message: message.error.message,
        status: message.error.status,
        retryAfterMs: message.error.retryAfterMs,
      }
    }
  }

  if (userIndex < 0) return null

  const user = messages[userIndex]
  const files = Array.isArray(user.files) ? user.files : []
  // 没有正文也没有附件的用户消息不该重投（空消息重投会 400）
  if (!(user.text ?? '').trim() && files.length === 0) return null

  // 最新结局不是 failed：要么成功，要么被用户停掉，都不该自动重投
  if (failures === 0 || lastOutcome !== 'failed') return null

  return {
    userMessageID: user.id,
    text: user.text ?? '',
    files,
    attempts: failures,
    failure: lastFailure ?? {},
  }
}
