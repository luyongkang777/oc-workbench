/**
 * 「重投一次」这个动作本身：回撤失败那一轮 → 同 id 重发。
 *
 * 单独拆出来是因为它有三条必须守住的规矩，比判定/排期更容易写错：
 *   1. 动回撤之前要确认会话没切、用户没停（由 `contextOk` 判断）；
 *   2. 只 stage 还没 commit 时退回原样是安全的，这时要清掉自己的回撤；
 *   3. **commit 之后必须把消息发出去**——服务端已经把那一轮删了，
 *      不发就等于把用户的话丢了。
 *
 * 失败时把「够不够回滚」的信息交回给调用方，由 hook 决定计数与提示。
 */
import type { ChatMessage } from '../api/chat'
import { commitRevert, stageRevert } from '../api/chat'
import { sendPromptWithRetry } from '../api/chatRetry'
import type { PendingRetry } from '../components/chatAutoRetry'
import type { PromptFile } from '../api/chat'

export type RetryOnceOutcome =
  /** 已经发出去，服务端开始跑 */
  | { kind: 'sent' }
  /** 用户切走 / 停止，没动或只动了 stage（已清回） */
  | { kind: 'aborted'; staged: boolean }
  /** 真的失败了；reverted=true 表示服务端那一轮已经被删掉 */
  | { kind: 'failed'; staged: boolean; reverted: boolean; restored: boolean; message: string }

type Options = {
  sessionID: string
  retry: PendingRetry
  promptFiles: PromptFile[]
  /** 会话没切、用户没停 */
  contextOk: () => boolean
  /** 只清「自己那条」回撤（内部会读回服务端边界比对） */
  clearOwnRevert: (sessionID: string, messageID: string) => Promise<void>
  /** 回撤后没发出去：让界面跟服务端对齐 */
  onResync?: (sessionID: string, boundaryMessageID: string) => void
  /** 回撤后没发出去：把原文还给输入框，返回是否真的给回去了 */
  onRestoreDraft?: (sessionID: string, text: string) => boolean
}

export async function runRetryOnce(options: Options): Promise<RetryOnceOutcome> {
  const { sessionID, retry, promptFiles, contextOk, clearOwnRevert } = options
  let staged = false
  let reverted = false

  try {
    if (!contextOk()) return { kind: 'aborted', staged: false }
    await stageRevert(sessionID, retry.userMessageID, false)
    staged = true

    if (!contextOk()) {
      await clearOwnRevert(sessionID, retry.userMessageID)
      return { kind: 'aborted', staged: true }
    }
    await commitRevert(sessionID)
    reverted = true

    await sendPromptWithRetry(sessionID, retry.text, promptFiles, retry.userMessageID, {
      // 这一层只投一次：投递本身再失败由调用方放开标记、下一拍接手
      maxAttempts: 1,
    })
    return { kind: 'sent' }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    let restored = false
    if (!reverted) {
      if (staged) await clearOwnRevert(sessionID, retry.userMessageID)
    } else {
      options.onResync?.(sessionID, retry.userMessageID)
      restored = options.onRestoreDraft?.(sessionID, retry.text) ?? false
    }
    return { kind: 'failed', staged, reverted, restored, message }
  }
}

/** 把服务端存下来的附件还原成发送用的 uri。没有可用 uri 的直接丢掉。 */
export function toPromptFiles(files: NonNullable<ChatMessage['files']>): PromptFile[] {
  const out: PromptFile[] = []
  for (const file of files) {
    const uri =
      file.uri ??
      (file.data ? `data:${file.mime ?? 'application/octet-stream'};base64,${file.data}` : '')
    if (!uri) continue
    out.push({ uri, name: file.name })
  }
  return out
}
