import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ACCOUNT_EVENT,
  deviceUrl,
  gatewayDevices,
  getGatewayToken,
  getGatewayUrl,
  type GatewayDevice,
} from '../api/gateway'

/**
 * 同账号下的在线电脑（手机/桌面顶部的设备切换条）。
 *
 * 数据源就是网关的 `/portal/api/devices`：里面的 `online` 由网关真探到工作台本身，
 * `busy` 由各设备自己的工作台算（有没有工作台会话正在生成）。所以这一段不需要
 * 本地 opencode 接口，未登录时直接空着。
 *
 * 为什么轮询 12 秒：设备状态不是关键指标，太勤快只白耗手机流量；而切换动作
 * 每次都会重新拉一遍列表换新票据，不依赖这里的新旧。
 */
const POLL_MS = 12_000

/** 轮询失败时的重试间隔：断网时 12 秒一次会一直空转，拉长到 30 秒。 */
const RETRY_MS = 30_000

/**
 * 当前页面是哪台设备。
 *
 * 入口永远是 `/u/<设备ID>/`（本机 WebView2 和手机远程都一样），所以从路径取最可靠，
 * 不用额外请求 `/local/account/device`（手机上一次往返 60~90ms，没必要）。
 */
export function currentDeviceId(): string {
  if (typeof window === 'undefined') return ''
  const match = /^\/u\/([A-Za-z0-9_-]+)/.exec(window.location.pathname)
  return match ? match[1] : ''
}

export type DeviceStripState = {
  /** 同账号下**在线**的设备；离线的不占顶部空间。 */
  devices: GatewayDevice[]
  /** 当前页面所在设备的 ID（可能为空：dev 环境没有前缀）。 */
  currentId: string
  /** 正在切换到的设备 ID（空串 = 没在切）。 */
  switching: string
  switchTo: (id: string) => void
}

export function useDeviceStrip(): DeviceStripState {
  const [devices, setDevices] = useState<GatewayDevice[]>([])
  const [switching, setSwitching] = useState('')
  const currentId = currentDeviceId()
  // 切走时页面就开始卸载了，别再让 setState 打进已卸载的树
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const token = getGatewayToken()
    if (!token) {
      setDevices((prev) => (prev.length ? [] : prev))
      return true
    }
    try {
      const data = await gatewayDevices(getGatewayUrl(), token)
      if (!alive.current) return true
      setDevices(data.devices ?? [])
      return true
    } catch {
      // 网络抖动：保留上一次的结果，灯宁可旧一会儿也不要突然全消失。
      return false
    }
  }, [])

  useEffect(() => {
    let timer = 0
    let stopped = false

    const tick = async () => {
      if (stopped) return
      let ok = true
      if (!document.hidden) ok = await load()
      if (stopped) return
      timer = window.setTimeout(tick, ok ? POLL_MS : RETRY_MS)
    }

    void tick()
    // 账号面板里登录/退出：立刻刷一次，不用等下个轮询周期
    const onAccount = () => {
      void load()
    }
    // 手机从后台切回来：灯要立刻是新的，不能先亮 12 秒旧的
    const onVisible = () => {
      if (!document.hidden) void load()
    }
    window.addEventListener(ACCOUNT_EVENT, onAccount)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      window.clearTimeout(timer)
      window.removeEventListener(ACCOUNT_EVENT, onAccount)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  const switchTo = useCallback(
    (id: string) => {
      const target = devices.find((dev) => dev.id === id)
      if (!target || id === currentId) return
      setSwitching(id)
      const host = getGatewayUrl()
      const token = getGatewayToken()
      void (async () => {
        let url = target.url
        if (token) {
          try {
            // 票据只活 10 分钟：设备条可能挂了一整天，切之前必须换一张新的，
            // 否则会跳到「设备在线，点开却是 401」。
            const data = await gatewayDevices(host, token)
            const fresh = data.devices.find((dev) => dev.id === id)
            if (fresh) url = fresh.url
          } catch {
            // 刷新失败就用手里的旧 URL，至少还有一次机会
          }
        }
        window.location.href = deviceUrl(host, { ...target, url })
      })()
    },
    [devices, currentId],
  )

  return {
    devices: devices.filter((dev) => dev.online),
    currentId,
    switching,
    switchTo,
  }
}
