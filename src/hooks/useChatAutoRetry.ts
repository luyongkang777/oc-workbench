/**
 * 一轮对话失败后自动重投。
 *
 * 分工：判定（`chatAutoRetry.pendingRetry`）和节奏（`retryPolicy`）都是纯函数，
 * 真正「回撤 + 重发」的动作在 `retryOnce.ts`，这里只负责「什么时候排、排几次」。
 *
 * 触发点：消息列表变了就重新判定。它覆盖两条路径——
 *   1. 事件流推来 idle（模型调用失败的那条消息）；
 *   2. 断线重连后全量对账拉到的失败消息。
 *
 * 重投方式（2026-11-16 实测）：**先把失败的那一轮回撤掉，再用同一个
 * message id 重发**。opencode 2.3 的 `POST /session/{id}/prompt` 对已存在的
 * message id 只返回已有消息、不再调度模型，不删就重投等于假重试。
 *
 * 因为回撤会把失败消息删掉，服务端算出来的「失败次数」每次都会从 1 重新数，
 * 所以**重试计数必须按 message id 本地记账**（`failureCount` 有单测）。键用
 * 「已经排过几次」而不是失败次数：服务端计数归零后拿它当键第二轮就撞上。
 *
 * 两条硬规矩：
 *   - 定时器真的触发时要**重新判定**：等待窗口里这一轮可能被救回、被别的
 *     客户端接手、或者用户点了停止，旧结论不能直接拿去删消息；
 *   - 重投这段自身失败要能再来一次：失败不产生新 idle、失败次数不涨，
 *     所以 catch 分支必须把 handled 键撤掉。
 */
import { useEffect, useRef } from 'react'
import type { ChatMessage } from '../api/chat'
import { clearRevert, getSession } from '../api/chat'
import { pendingRetry, type PendingRetry } from '../components/chatAutoRetry'
import {
  failureCount,
  isRetryableFailure,
  normalizeRetryAttempts,
  retryDelay,
  retryGiveUpText,
  retryNoticeText,
  shouldGiveUp,
} from '../components/retryPolicy'
import { runRetryOnce, toPromptFiles } from './retryOnce'

/** 已处理键最多留多少条：长会话里每轮失败都会加一条，不清理会一直涨。 */
const HANDLED_LIMIT = 200
/** 本地计数表上限：按 message id 记账，防止长会话无限增长。 */
const ATTEMPT_LIMIT = 200

type Status = { tone: 'info' | 'fail' | 'ok'; text: string; detail?: string }

type Options = {
  /** 当前会话 id；空 = 不盯 */
  sessionID: string | null
  /** 当前消息列表（倒序，最新在前） */
  messages: ChatMessage[]
  /** 是否连上后端：断开时不该重投（重投也只会再失败一次） */
  connected: boolean
  /** 最多重试次数（3~8，由 retryPolicy 收敛） */
  maxAttempts: number
  /** 重试进度/放弃时回报给界面 */
  onStatus: (status: Status | null) => void
  /**
   * 重投已经发出（服务端那一轮已删、新的一轮已入队）。
   * 上层要按 boundary 本地截断再重拉，否则 mergeMessages 只增不删，
   * 界面会残留已经被服务端删掉的失败气泡。
   */
  onRetried: (sessionID: string, boundaryMessageID: string) => void
  /** 回撤后没发出去：只把本地对齐到服务端（截断 + 重拉），不启动生成态 */
  onResync?: (sessionID: string, boundaryMessageID: string) => void
  /**
   * 回撤成功但重投没发出去时，把用户原文还给输入框。
   * 返回 true 表示已经放到用户能找到的地方（输入框 / 那个会话的草稿）。
   */
  onRestoreDraft?: (sessionID: string, text: string) => boolean
  /** 用户正在停止/回撤这一轮、或服务端还在跑：暂停自动重投 */
  suspended: boolean
}

/** 同一轮失败只处理一次：键 = 会话 + 用户消息 + 已排过几次重投。 */
function attemptKey(sessionID: string, retry: PendingRetry, ordered: number): string {
  return `${sessionID}:${retry.userMessageID}:${ordered}`
}

export function useChatAutoRetry(options: Options): void {
  const { sessionID, messages, connected, maxAttempts, suspended } = options

  const cb = useRef(options)
  cb.current = options

  /** 已经安排过的键：避免同一状态被重复排两次 */
  const handled = useRef<string[]>([])
  /** 按 message id 记「已经排过几次」：消息被回撤后服务端计数会归零 */
  const orderedByMessage = useRef<Map<string, number>>(new Map())
  /** 正在等待重投的会话：同一时刻只排一个 */
  const timer = useRef<number | null>(null)
  /** 正在重投的键 */
  const inflight = useRef<string | null>(null)
  /** 屏幕上那条提示是不是我们写的（只收自己写的，别抹掉别人的提示） */
  const ownNotice = useRef(false)

  const remember = (key: string) => {
    if (handled.current.includes(key)) return
    handled.current.push(key)
    if (handled.current.length > HANDLED_LIMIT) handled.current.shift()
  }

  const forget = (key: string) => {
    handled.current = handled.current.filter((item) => item !== key)
  }

  const setOrdered = (messageID: string, value: number) => {
    orderedByMessage.current.set(messageID, value)
    if (orderedByMessage.current.size > ATTEMPT_LIMIT) {
      const oldest = orderedByMessage.current.keys().next().value
      if (oldest) orderedByMessage.current.delete(oldest)
    }
  }

  /**
   * 清掉「自己 staged 的那次回撤」。
   *
   * `staged.messageID` 恒等于自己的边界，无法区分它有没有被用户的回撤覆盖，
   * 所以必须读回服务端的 session.revert 再比一次；读不到就不动 —— 宁可不干净，
   * 也不能把用户刚暂存的回撤清掉。
   */
  const clearOwnRevert = async (targetSession: string, messageID: string) => {
    try {
      const session = await getSession(targetSession)
      if (session.revert?.messageID === messageID) await clearRevert(targetSession)
    } catch {
      // 会话忙 / 网络抖动：保持现状，交给用户或下一拍
    }
  }

  // 切会话 / 卸载才清：messages 变化不清，否则会把刚排上的重试定时器清掉
  useEffect(() => {
    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
      }
      inflight.current = null
      handled.current = []
      orderedByMessage.current.clear()
    }
  }, [sessionID, connected])

  useEffect(() => {
    if (!connected || !sessionID || suspended) return
    // 已经有一个在等：不要叠第二个
    if (timer.current !== null || inflight.current !== null) return

    const retry = pendingRetry(messages)
    if (!retry) {
      // 这一轮已经正常了：把自己留下的「正在重试 / 重投已发出」收起来
      if (ownNotice.current) {
        ownNotice.current = false
        cb.current.onStatus(null)
      }
      return
    }

    const ordered = orderedByMessage.current.get(retry.userMessageID) ?? 0
    const failures = failureCount(retry.attempts, ordered)
    const key = attemptKey(sessionID, retry, ordered)
    if (handled.current.includes(key)) return

    const reason = retry.failure.message?.trim() || retry.failure.type || '未知原因'

    // 带附件的一轮必须能完整还原附件才敢重投：还原不出来就会把用户的图片/文件抹掉
    const promptFiles = toPromptFiles(retry.files)
    if (retry.files.length > 0 && promptFiles.length < retry.files.length) {
      remember(key)
      cb.current.onStatus({
        tone: 'fail',
        text: '对话已中断，且附件无法自动还原',
        detail: '请重新发送这条消息（附件还留在你的设备上）',
      })
      return
    }

    // 不可恢复的失败（模型不存在、密钥错、参数非法）别重试
    if (!isRetryableFailure(retry.failure)) {
      remember(key)
      cb.current.onStatus({
        tone: 'fail',
        text: `对话已中断：${reason}`,
        detail: '这类错误重试也不会好，请检查模型或配置后重新发送',
      })
      return
    }

    if (shouldGiveUp(failures, maxAttempts)) {
      remember(key)
      cb.current.onStatus({
        tone: 'fail',
        text: retryGiveUpText(failures, maxAttempts, reason),
        detail: '可以直接重新发送，或换个模型再试',
      })
      return
    }

    remember(key)
    inflight.current = key
    const attemptNo = failures
    const max = normalizeRetryAttempts(maxAttempts)
    const delayMs = retryDelay(failures, retry.failure.retryAfterMs)
    ownNotice.current = true
    cb.current.onStatus({
      tone: 'info',
      text: retryNoticeText(attemptNo, max),
      detail: retry.failure.message?.trim() ? `上次失败：${retry.failure.message.trim()}` : undefined,
    })

    /** 这一次重投的前提还在不在：会话没切、用户没停。 */
    const contextOk = () => cb.current.sessionID === sessionID && !cb.current.suspended

    timer.current = window.setTimeout(() => {
      timer.current = null
      if (!contextOk()) {
        forget(key)
        inflight.current = null
        return
      }
      // 等待窗口里这一轮可能已经被救回来了（服务端自己重试成功、别的客户端接手、
      // 用户点了停止后消息变成 interrupted）。旧结论不能直接拿来删消息。
      const now = pendingRetry(cb.current.messages)
      if (!now || now.userMessageID !== retry.userMessageID) {
        // 消息短暂对不上（SSE 重连、分页没拉全）：撤掉标记等补齐后重新判定
        forget(key)
        inflight.current = null
        return
      }

      void (async () => {
        setOrdered(retry.userMessageID, ordered + 1)
        const outcome = await runRetryOnce({
          sessionID,
          retry,
          promptFiles,
          contextOk,
          clearOwnRevert,
          onResync: (target, boundary) => cb.current.onResync?.(target, boundary),
          onRestoreDraft: (target, text) => cb.current.onRestoreDraft?.(target, text) ?? false,
        })
        try {
          if (outcome.kind === 'sent') {
            cb.current.onStatus({
              tone: 'info',
              text: retryNoticeText(attemptNo, max),
              detail: '重投已发出，等待模型响应',
            })
            cb.current.onRetried(sessionID, retry.userMessageID)
            return
          }

          // 没发出去：这一次不算「真实失败」的推进，把计数退回去
          setOrdered(retry.userMessageID, ordered)
          forget(key)
          if (outcome.kind === 'aborted') return

          cb.current.onStatus({
            // 已经回撤但没发出去：这一轮在服务端没了，用户需要看到并自己处理，
            // 所以用 fail（不会随「这一轮已恢复」的清理一起消失）
            tone: outcome.reverted ? 'fail' : 'info',
            text: outcome.reverted ? '对话已中断' : retryNoticeText(attemptNo, max),
            detail: outcome.reverted
              ? outcome.restored
                ? `重投没有成功（原文已放回输入框），可以直接重新发送：${outcome.message}`
                : `重投没有成功，原文没能放回输入框，请手动重发：${outcome.message}`
              : `重投没有成功：${outcome.message}`,
          })
        } finally {
          inflight.current = null
        }
      })()
    }, delayMs)
  }, [connected, sessionID, messages, maxAttempts, suspended])
}
