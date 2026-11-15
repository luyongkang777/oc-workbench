import { useCallback, useEffect, useRef, useState } from 'react'

import {
  BALANCE_REFRESH_EVENT,
  canForceRefresh,
  fetchDeepSeekBalance,
  type DeepSeekBalance,
} from '../api/balance'
import { onPageVisible, pageVisible } from '../api/visibility'
import { formatBalance } from './balanceFormat'
import BalancePanel from './BalancePanel'

/**
 * 顶栏的 DeepSeek 官方余额胶囊。
 *
 * 刷新策略（目标是「花了钱马上能看到」）：
 *
 *   * 15 秒兜底轮询 —— 别处（手机 / CLI / 另一台电脑）的消耗也能跟上；
 *   * **每轮模型调用结束**（`session.step.ended` 广播）→ 立刻查一次；
 *   * 窗口重新获得焦点、或从后台切回来 → 立刻查一次；
 *   * 上面「立刻查」有 2.5 秒节流（`canForceRefresh`），后端另有 4 秒缓存防抖；
 *   * 页面不可见时不轮询，切回来补一次。
 */
const POLL_MS = 15_000

/** busy 卡多久算「请求死了」：超过就强制放行新请求。 */
const BUSY_STUCK_MS = 20_000

export default function BalanceChip() {
  const [state, setState] = useState<DeepSeekBalance | null>(null)
  const [busy, setBusy] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const aliveRef = useRef(true)
  const busyRef = useRef(false)
  const pendingRef = useRef(false)
  const lastForceRef = useRef(0)
  const busySinceRef = useRef(0)
  /** 首次拿不到凭据时的重试计数（成功即清零）。 */
  const retryRef = useRef(0)
  const loadRef = useRef<((refresh: boolean) => void) | null>(null)

  const load = useCallback((refresh: boolean) => {
    if (busyRef.current) {
      // 兜底：请求异常卡住时不能把之后所有刷新都堵死（实测踩过：body 一直不回来
      // 导致 busy 永远为 true，余额停在旧值上再也不动）。
      if (Date.now() - busySinceRef.current < BUSY_STUCK_MS) {
        // 正常并发：记一笔「等下还要查」的意图，别把最新的刷新请求丢掉
        if (refresh) pendingRef.current = true
        return
      }
      busyRef.current = false
    }
    busyRef.current = true
    busySinceRef.current = Date.now()
    setBusy(true)
    void (async () => {
      try {
        const next = await fetchDeepSeekBalance(refresh)
        if (!aliveRef.current) return
        setState(next)
        if (next.ok) {
          retryRef.current = 0
          return
        }
        // 外壳的令牌是页面加载后经 IPC 下发的：exe 刚启动/F5 之后第一次查往往还是 403。
        // 这里按递增间隔补几次，别让胶囊顶着「余额 —」等到下一个 15 秒轮询。
        // 「没配密钥」这类不会自愈的错误不重试。
        const message = next.error ?? ''
        const transient = !message.includes('没有找到') && /凭据|超时|失败/.test(message)
        if (transient && retryRef.current < 5) {
          retryRef.current += 1
          const delay = 1200 * retryRef.current
          window.setTimeout(() => {
            if (aliveRef.current) loadRef.current?.(true)
          }, delay)
        }
      } finally {
        busyRef.current = false
        if (aliveRef.current) setBusy(false)
        if (pendingRef.current) {
          pendingRef.current = false
          loadRef.current?.(true)
        }
      }
    })()
  }, [])

  loadRef.current = load

  /**
   * 消耗之后要立刻看结果：事件流 / 切回窗口 / 聚焦都走这里，2.5 秒内只打一次。
   *
   * 注意这里用 `load(false)`（走后端 4 秒防抖缓存）而不是 `refresh=true`：
   * 一次对话会连着来好几个 step.ended，全都绕过缓存的话就是每 2.5 秒真打一次官方
   * 接口。4 秒窗口内合并之后，既看不出延迟，也不会把官方接口打急。
   */
  const forceLoad = useCallback(() => {
    const now = Date.now()
    if (!canForceRefresh(lastForceRef.current, now)) return
    lastForceRef.current = now
    load(false)
  }, [load])

  useEffect(() => {
    aliveRef.current = true
    load(true)
    const timer = window.setInterval(() => {
      if (pageVisible()) load(false)
    }, POLL_MS)
    const offVisible = onPageVisible(forceLoad)
    const onFocus = () => forceLoad()
    const onRefreshEvent = () => forceLoad()
    window.addEventListener('focus', onFocus)
    window.addEventListener(BALANCE_REFRESH_EVENT, onRefreshEvent)
    return () => {
      aliveRef.current = false
      window.clearInterval(timer)
      offVisible()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(BALANCE_REFRESH_EVENT, onRefreshEvent)
    }
  }, [load, forceLoad])

  const closePanel = useCallback(() => setPanelOpen(false), [])
  const changed = useCallback(() => {
    lastForceRef.current = Date.now()
    load(true)
  }, [load])
  const refresh = useCallback(() => {
    lastForceRef.current = Date.now()
    load(true)
  }, [load])

  const view = formatBalance(state)
  return (
    <>
      <button
        type="button"
        className={`balance-chip ${view.tone}`}
        title={busy ? '正在刷新余额…' : `${view.title}（点击打开余额面板）`}
        aria-label={`DeepSeek 余额：${view.text}`}
        data-balance={view.tone}
        onClick={() => setPanelOpen(true)}
      >
        <span className="balance-chip-dot" aria-hidden="true" />
        {view.text}
      </button>
      <BalancePanel
        open={panelOpen}
        onClose={closePanel}
        onChanged={changed}
        snapshot={state}
        onRefresh={refresh}
        refreshing={busy}
      />
    </>
  )
}
