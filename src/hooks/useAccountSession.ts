import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_GATEWAY,
  clearGatewaySession,
  claimDevice,
  setTunnelPort,
  deviceUrl,
  gatewayDevices,
  gatewayLogin,
  loadSessionFile,
  localDevice,
  getGatewayToken,
  getGatewayUrl,
  getGatewayUser,
  saveGatewaySession,
  setGatewayUrl,
  type GatewayDevice,
} from '../api/gateway'

/**
 * 账号面板的全部状态与副作用。
 *
 * 从 AccountPanel 里抽出来的：组件本身只剩渲染，状态逻辑集中在这里，
 * 便于以后加「切换账号」「设备重命名」之类不改 JSX 的功能。
 *
 * 两条容易踩的规则（改动前先看）：
 *  1. `claimSelf` 必须定义在 `loadDevices` **之前** —— loadDevices 的依赖数组
 *     在 useCallback 求值时就会读它，放后面是立即 TDZ 崩溃。
 *  2. 每次 `loadDevices` 都要先 claim 一次本机：设备归属会被别处改掉，
 *     只在登录时认领会表现为「登录着却看不到自己的电脑」。
 */
export function useAccountSession(open: boolean, onOpenDevice: (url: string, name: string) => void) {
  const [base, setBase] = useState(() => getGatewayUrl())
  const [token, setToken] = useState(() => getGatewayToken())
  const [username, setUsername] = useState(() => getGatewayUser())
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [devices, setDevices] = useState<GatewayDevice[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [claimHint, setClaimHint] = useState('')
  const [editBase, setEditBase] = useState(false)

  // 登录后把这台电脑登记到当前账号下（exe 自己就是一台电脑，不该再让用户去扫码配对）
  const claimSelf = useCallback(async (tk: string, host: string) => {
    const local = await localDevice()
    if (!local) return // dev / 手机：没有本机身份，跳过
    try {
      const claimed = await claimDevice(host, tk, local)
      setClaimHint('')
      // 拿到回环端口就交给 exe 建隧道：这样「登录一次」就等于「这台电脑在线」，
      // 不需要用户再手动跑 remote-tunnel.ps1 或挂看门狗。
      if (claimed.port) void setTunnelPort(claimed.port)
    } catch (err) {
      // 认领失败要让人看见（不然只会觉得「怎么没有我的电脑」）；常见原因是设备 token 对不上
      setClaimHint(`本机登记失败：${(err as Error).message}`)
    }
  }, [])

  const loadDevices = useCallback(
    async (tk: string, host: string) => {
      setBusy(true)
      setError('')
      // 把网关地址同步给 exe（导航白名单要用）。从 localStorage 恢复会话时
      // 不会走 submitLogin，这里补一次，否则「点开别的电脑」会被静默拦掉。
      setGatewayUrl(host)
      try {
        await claimSelf(tk, host)
        const data = await gatewayDevices(host, tk)
        setDevices(data.devices)
        setUsername(data.username)
        // 网关在剩余有效期不足 2 天时会下发新 token（滑动续期），换掉本地的。
        if (data.token && data.token !== tk) {
          saveGatewaySession(data.token, data.username)
          setToken(data.token)
        }
      } catch (err) {
        const message = (err as Error).message
        // token 失效就退回登录态，别让用户对着空列表发呆
        if (/401|未登录|过期/.test(message)) {
          clearGatewaySession()
          setToken('')
        }
        setError(message)
      } finally {
        setBusy(false)
      }
    },
    [claimSelf],
  )

  useEffect(() => {
    if (open && token) void loadDevices(token, getGatewayUrl())
  }, [open, token, loadDevices])

  // 点开设备前先刷新一次列表：设备 URL 里的票据只活 10 分钟，
  // 面板开久了直接拿旧 url 去导航会变成「设备在线，点开却是 401 票据无效」。
  const openDevice = useCallback(
    async (dev: GatewayDevice) => {
      const host = getGatewayUrl()
      try {
        const data = await gatewayDevices(host, token)
        const fresh = data.devices.find((d) => d.id === dev.id) ?? dev
        onOpenDevice(deviceUrl(host, fresh), fresh.name)
      } catch {
        // 刷新失败（网络抖动）就用手里的旧 URL，至少还有一次机会
        onOpenDevice(deviceUrl(host, dev), dev.name)
      }
    },
    [token, onOpenDevice],
  )

  // 启动时：localStorage 没有登录态就从本地文件恢复（清 WebView2 缓存也不丢）
  useEffect(() => {
    if (token) return
    let alive = true
    void (async () => {
      const saved = await loadSessionFile()
      if (!alive || !saved?.token) return
      if (saved.gateway) {
        setGatewayUrl(saved.gateway)
        setBase(saved.gateway)
      }
      saveGatewaySession(saved.token, saved.username)
      setToken(saved.token)
      setUsername(saved.username)
      void claimSelf(saved.token, saved.gateway || getGatewayUrl())
    })()
    return () => {
      alive = false
    }
    // 只在挂载时尝试一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submitLogin = useCallback(async () => {
    if (!name.trim() || !password) {
      setError('用户名和密码都要填')
      return
    }
    setBusy(true)
    setError('')
    setClaimHint('')
    const host = base.trim().replace(/\/+$/, '') || DEFAULT_GATEWAY
    try {
      setGatewayUrl(host)
      const session = await gatewayLogin(host, name.trim(), password)
      saveGatewaySession(session.token, session.username)
      setToken(session.token)
      setUsername(session.username)
      setPassword('')
      // loadDevices 内部会先认领一次，这里不用重复调用
      await loadDevices(session.token, host)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [base, name, password, loadDevices])

  const logout = useCallback(() => {
    clearGatewaySession()
    setToken('')
    setUsername('')
    setDevices([])
    setPassword('')
    setClaimHint('')
  }, [])

  const refresh = useCallback(() => {
    if (!token) return
    void loadDevices(token, base)
  }, [token, base, loadDevices])

  return {
    base,
    setBase,
    token,
    username,
    name,
    setName,
    password,
    setPassword,
    devices,
    busy,
    error,
    claimHint,
    editBase,
    setEditBase,
    submitLogin,
    logout,
    refresh,
    openDevice,
  }
}
