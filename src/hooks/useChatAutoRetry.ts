/**
 * 一轮对话失败后自动重投。
 *
 * 分工：判定（`chatAutoRetry.pendingRetry`）和节奏（`retryPolicy`）都是纯函数，
 * 这里只负责「什么时候看、看完做什么」。
 *
 * 触发点：消息列表变了就重新判定。它覆盖两条路径——
 *   1. 事件流推来 idle（模型调用失败的那条消息）；
 *   2. 断线重连后全量对账拉到的失败消息。
 *
 * 重投用同一个 message id：服务端按 id 幂等，不会把用户的话发两遍，
 * 但会重新调度一轮模型调用（实测 `resume: true` 生效）。所以「重试」在
 * 服务端看来就是「这轮继续跑」。
 *
 * 两个容易写错的地方（这版已经避开）：
 *   - **不能在 messages 变化的 cleanup 里清定时器**：流式输出期间 messages
 *     一秒变几十次，cleanup 会把刚排好的重试定时器清掉，而下一轮判定又因为
 *     「这条已经处理过」直接返回，重试就永久丢了。清理只在切会话/卸载时做。
 *   - **重投这一下自身失败要能再来一次**：POST 失败不会产生新的 idle 消息，
 *     失败次数不涨，键不变；如果键已被标记处理过就永远卡住。所以 catch 里
 *     把标记撤掉，让下一拍重新判定。
 */
import { useEffect, useRef } from 'react'
import type { ChatMessage } from '../api/chat'
import { pendingRetry, type PendingRetry } from '../components/chatAutoRetry'
import {
  isRetryableFailure,
  retryDelay,
  retryGiveUpText,
  retryNoticeText,
  shouldGiveUp,
} from '../components/retryPolicy'
import { sendPromptWithRetry } from '../api/chatRetry'
import type { PromptFile } from '../api/chat'

/** 已处理键最多留多少条：长会话里每轮失败都会加一条，不清理会一直涨。 */
const HANDLED_LIMIT = 200

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
  /** 重投成功后让上层重拉一次消息 */
  onRetried: (sessionID: string) => void
  /** 用户正在停止/回撤这一轮：暂停自动重投 */
  suspended: boolean
}

/** 同一轮失败只处理一次：键 = 会话 + 用户消息 + 已失败次数。 */
function attemptKey(sessionID: string, retry: PendingRetry): string {
  return `${sessionID}:${retry.userMessageID}:${retry.attempts}`
}

/** 把服务端存下来的附件还原成发送用的 uri。没有可用 uri 的直接丢掉。 */
function toPromptFiles(files: NonNullable<ChatMessage['files']>): PromptFile[] {
  const out: PromptFile[] = []
  for (const file of files) {
    const uri =
      file.uri ??
      (file.data
        ? `data:${file.mime ?? 'application/octet-stream'};base64,${file.data}`
        : '')
    if (!uri) continue
    out.push({ uri, name: file.name })
  }
  return out
}

export function useChatAutoRetry(options: Options): void {
  const { sessionID, messages, connected, maxAttempts, onStatus, onRetried, suspended } = options

  const cb = useRef(options)
  cb.current = options

  /** 已经安排过的键：避免同一状态被重复排两次 */
  const handled = useRef<string[]>([])
  /** 正在等待重投的会话：同一时刻只排一个 */
  const timer = useRef<number | null>(null)
  /** 正在重投的键 */
  const inflight = useRef<string | null>(null)
  /**
   * 屏幕上那条提示是不是我们写的。
   *
   * 只收自己写的：压缩上下文、回撤这些也共用同一个提示条，
   * 无脑清空会把别人的提示一起抹掉。
   */
  const ownNotice = useRef(false)

  const remember = (key: string) => {
    if (handled.current.includes(key)) return
    handled.current.push(key)
    if (handled.current.length > HANDLED_LIMIT) handled.current.shift()
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
    }
  }, [sessionID, connected])

  useEffect(() => {
    if (!connected || !sessionID || suspended) return
    // 已经有一个在等：不要叠第二个
    if (timer.current !== null || inflight.current !== null) return

    const retry = pendingRetry(messages)
    if (!retry) {
      // 这一轮已经正常了（有输出、或结局是成功/中断）：
      // 把自己留下的「正在重试 / 重投已发出」收起来，别让它一直挂着。
      if (ownNotice.current) {
        ownNotice.current = false
        cb.current.onStatus(null)
      }
      return
    }

    const key = attemptKey(sessionID, retry)
    if (handled.current.includes(key)) return

    const reason = retry.failure.message?.trim() || retry.failure.type || '未知原因'

    // 带附件的一轮必须能完整还原附件才敢重投：
    // 服务端按消息 id 幂等，重投会替换这条消息的 payload；如果附件还原不出来
    // 还照样发，等于把用户原来带的图片/文件抹掉。
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

    // 已经重试满额：停在失败态等用户处理
    if (shouldGiveUp(retry.attempts, maxAttempts)) {
      remember(key)
      cb.current.onStatus({
        tone: 'fail',
        text: retryGiveUpText(retry.attempts, maxAttempts, reason),
        detail: '可以直接重新发送，或换个模型再试',
      })
      return
    }

    remember(key)
    inflight.current = key
    // 计数口径和 sendWithRetry 保持一致：失败了几次，就是正在做第几次重试
    const attempt = retry.attempts
    const delayMs = retryDelay(retry.attempts, retry.failure.retryAfterMs)
    ownNotice.current = true
    cb.current.onStatus({
      tone: 'info',
      text: retryNoticeText(attempt, maxAttempts),
      detail: retry.failure.message?.trim() ? `上次失败：${retry.failure.message.trim()}` : undefined,
    })

    timer.current = window.setTimeout(() => {
      timer.current = null
      const sid = cb.current.sessionID
      if (!sid || sid !== sessionID) {
        inflight.current = null
        return
      }
      if (cb.current.suspended) {
        // 用户这会儿在压缩上下文 / 正在发别的消息：这条先不重投。
        // 但要把标记撤掉 —— 否则等他忙完，这个失败永远不会再被接手。
        handled.current = handled.current.filter((item) => item !== key)
        inflight.current = null
        return
      }
      void sendPromptWithRetry(sessionID, retry.text, promptFiles, retry.userMessageID, {
        // 这一层只投一次：投递本身再失败由下面的 catch 放开标记、下一拍接手
        maxAttempts: 1,
      })
        .then(() => {
          cb.current.onStatus({
            tone: 'info',
            text: retryNoticeText(attempt, maxAttempts),
            detail: '重投已发出，等待模型响应',
          })
          cb.current.onRetried(sessionID)
        })
        .catch((err: unknown) => {
          const message = (err as Error)?.message ?? String(err)
          // 撤掉标记：投递失败不会产生新的 idle 消息，失败次数不涨，
          // 不放开的话这条就永远卡在这儿
          handled.current = handled.current.filter((item) => item !== key)
          cb.current.onStatus({
            tone: 'info',
            text: retryNoticeText(attempt, maxAttempts),
            detail: `重投没有成功：${message}`,
          })
        })
        .finally(() => {
          inflight.current = null
        })
    }, delayMs)
  }, [connected, sessionID, messages, maxAttempts, suspended])
}
