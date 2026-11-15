import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthState } from '../api/auth'
import { retryAuth } from '../api/auth'
import { getInfo, getShellState, reconnect } from '../api/client'
import { onPageVisible, pageVisible } from '../api/visibility'
import {
  hiddenRecheckDelay,
  nextReconnectDelay,
  shouldReconnectNow,
} from '../components/connectionPolicy'

const PROBE_INTERVAL_MS = 10_000
// 未连上时的快轮询间隔：后端 0.5 秒内就绪时用户感知不到等待。
const FAST_PROBE_INTERVAL_MS = 1_000

/**
 * 与「外壳 / opencode 服务」的连接状态：探活、断开自愈、手动重试。
 *
 * 从 App.tsx 抽出来的。这里集中了 4 个 effect 和 3 个 ref，
 * 是 App 里最容易改错的一块（探活节奏、后台标签页不重连、失败原因回填）。
 */
export function useConnection(authStatus: AuthState['status']) {
  // 组件是否还在树上：异步回调据此决定要不要写状态
  const alive = useRef(true)
  // 探活请求是否在途：定时探活不叠加；finally 里保证复位
  const probing = useRef(false)
  const [connected, setConnected] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /** 立即探活一次（带 15 秒超时），返回是否连上。 */
  const probeNow = useCallback(async (): Promise<boolean> => {
    probing.current = true
    try {
      await getInfo()
      if (alive.current) {
        setConnected(true)
        setRetryError(null)
      }
      return true
    } catch {
      if (alive.current) setConnected(false)
      // 没连上就问外壳「为什么」：换台机器最常见的是 opencode 没装/找不到，
      // 原因直接显示在侧栏，不用用户先点一次「重试」。
      try {
        const state = await getShellState()
        if (alive.current) setRetryError(state.error)
      } catch {
        // 状态接口本身都没通（例如 dev 模式没有外壳）：保留原提示
      }
      return false
    } finally {
      probing.current = false
    }
  }, [])

  /** 定时探活用：上一次还没回来就跳过，避免请求越堆越多。 */
  const probeOnce = useCallback(() => {
    if (probing.current) return
    void probeNow()
  }, [probeNow])

  useEffect(() => {
    if (authStatus !== 'ready') return
    probeOnce()
    // 冷启动时后台还在配对，首次探活经常吃 502。断开态用 1 秒快轮询，
    // 连上后回到 10 秒，保证「启动到可操作」不被 10 秒间隔拖住。
    // 窗口不可见时跳过：最小化后没人看，恢复可见时立刻补一次。
    const delay = connected ? PROBE_INTERVAL_MS : FAST_PROBE_INTERVAL_MS
    const timer = window.setInterval(() => {
      if (pageVisible()) probeOnce()
    }, delay)
    const stopVisible = onPageVisible(probeOnce)
    return () => {
      window.clearInterval(timer)
      stopVisible()
    }
  }, [authStatus, connected, probeOnce])

  /**
   * 断开态自愈：不再等用户点「重试」。
   *
   * 探活失败只说明「此刻连不上」，真正能把状态拨回来的是让外壳重新配一次对
   * （`/api/reconnect` → `opencode service status` + `pair`）。以前这件事只挂在
   * 「重试」按钮上，于是后端晚起、服务重开换了端口、配对 cookie 过期之后，
   * 界面就一直停在「未连接」——「有时候打开一直是未连接」的根就在这。
   *
   * 节奏交给 connectionPolicy：第一次 1.2 秒后（先给外壳自己的 bootstrap 让路），
   * 之后 4s → 8s → 12s → 15s 退避；连上、或者切到后台就立刻停。
   */
  useEffect(() => {
    if (authStatus !== 'ready' || connected) return
    // dev server 没有外壳：Vite 代理盯死一个固定上游，没有「重新配对」这回事，
    // 自动打 /api/reconnect 只会拿 404 把错误条刷出来。dev 里保持手动「重试」原样。
    if (import.meta.env.DEV) return
    let cancelled = false
    let timer = 0
    let attempt = 0

    const step = async () => {
      if (cancelled) return
      // 后台标签页不跑配对：一次性链接会白生成，回到前台再由可见性事件补一次。
      if (!shouldReconnectNow(document.hidden)) {
        timer = window.setTimeout(step, hiddenRecheckDelay())
        return
      }
      attempt += 1
      if (alive.current) setReconnecting(true)
      try {
        await reconnect()
        if (!cancelled) await probeNow()
      } catch (err) {
        // 外壳会回 502 + 具体原因（找不到 opencode、pair 失败等），显示出来别让用户猜。
        if (alive.current) setRetryError((err as Error).message)
      } finally {
        if (alive.current) setReconnecting(false)
      }
      if (cancelled) return
      timer = window.setTimeout(step, nextReconnectDelay(attempt))
    }

    timer = window.setTimeout(step, nextReconnectDelay(0))
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [authStatus, connected, probeNow])

  // 从后台回到前台：立刻补一次探活，别等下一个 1 秒/10 秒周期才亮灯。
  useEffect(() => {
    if (authStatus !== 'ready') return
    const onVisibility = () => {
      if (document.hidden) return
      probeOnce()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [authStatus, probeOnce])

  /** 手动重试：没令牌时先重新走 IPC 握手，已有令牌时让外壳重新配对并立刻探活。 */
  const retryConnect = useCallback(async () => {
    if (reconnecting) return
    setReconnecting(true)
    try {
      if (authStatus === 'failed') {
        // 令牌都没拿到，直接打 /api/reconnect 必然 403；重新握手，等令牌到了再靠探活定状态
        await retryAuth()
        return
      }
      // 外壳会回 502 + 具体原因（找不到 opencode、pair 失败等），显示出来别让用户猜。
      try {
        await reconnect()
        if (alive.current) setRetryError(null)
      } catch (err) {
        if (alive.current) setRetryError((err as Error).message)
      }
      await probeNow()
    } finally {
      if (alive.current) setReconnecting(false)
    }
  }, [authStatus, reconnecting, probeNow])

  return { connected, reconnecting, retryError, probeNow, retryConnect }
}
