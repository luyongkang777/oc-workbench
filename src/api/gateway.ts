/**
 * 网关（账号 + 设备）客户端 API。
 *
 * exe 的页面在 127.0.0.1，网关在公网 IP，属于跨源：
 *  - 不能用 cookie（SameSite + 跨源），所以用 Bearer token
 *  - 网关对 /portal/api/* 放开了 CORS（只读自己的设备，风险可控）
 *
 * 登录态存两处：
 *  1. localStorage（快，页面内直接用）
 *  2. %LOCALAPPDATA%\oc-workbench\account.json（经 /local/account/session 读写）
 *     —— 清 WebView2 缓存 / 重装 exe 都不会丢
 * 网关在 token 剩余不足 2 天时会顺带下发新 token（滑动续期），这里自动换掉。
 */

const GATEWAY_KEY = 'oc-workbench:gateway'
const TOKEN_KEY = 'oc-workbench:gateway-token'
const USER_KEY = 'oc-workbench:gateway-user'

/** 默认网关地址（可以在面板里改）。 */
export const DEFAULT_GATEWAY = 'http://81.70.181.82:7800'

export type GatewayDevice = {
  id: string
  name: string
  port: number
  online: boolean
  lastSeen: number
  /** 相对路径，带 ?t= 与一次性票据 */
  url: string
}

function read(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function write(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value)
    else window.localStorage.removeItem(key)
  } catch {
    /* 存不进去就算了 */
  }
}

export function getGatewayUrl(): string {
  return read(GATEWAY_KEY).trim() || DEFAULT_GATEWAY
}

export function setGatewayUrl(url: string): void {
  const next = url.trim().replace(/\/+$/, '')
  write(GATEWAY_KEY, next)
  // 同步给 exe：它的导航白名单要放行这个地址，否则「点开别的电脑」会被静默拦掉
  // （设备页在公网 IP，和工作台自己的 127.0.0.1 不同源）。
  void fetch(localApi('/local/account/gateway'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: next }),
  }).catch(() => {
    /* dev / 手机没有这个本地接口，忽略 */
  })
}

export function getGatewayToken(): string {
  return read(TOKEN_KEY)
}

export function getGatewayUser(): string {
  return read(USER_KEY)
}

export function saveGatewaySession(token: string, username: string): void {
  write(TOKEN_KEY, token)
  write(USER_KEY, username)
  // 顺带落盘，清缓存后还能自动恢复
  void saveSessionFile({ token, username, gateway: getGatewayUrl() })
}

export function clearGatewaySession(): void {
  const tk = read(TOKEN_KEY)
  const host = getGatewayUrl()
  if (tk) {
    // 会话是服务端签名的自包含 token，只删本地副本的话它还能再用 7 天。
    // keepalive 保证紧接着跳转/关窗口时请求也能发出去。
    void fetch(`${host}/portal/api/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tk}` },
      keepalive: true,
    }).catch(() => {
      /* 网络不通也要继续清本地 */
    })
  }
  write(TOKEN_KEY, '')
  write(USER_KEY, '')
  void clearSessionFile()
}

// ---------- 本地文件持久化（经 exe 的 /local/account/session） ----------

const SESSION_PATH = '/local/account/session'

/**
 * 本地接口的完整路径。
 *
 * 远程模式下页面挂在 /u/<实例ID>/ 下，所有内部接口（/local/*、/api/*）都要带这个前缀，
 * 否则请求会落到网关的默认 location 变成 404 —— 表现就是「登录成功但会话永远存不下来」。
 * 这里内联一份（不 import base.ts：主仓库那份没有 base 模块）。
 */
function localApi(path: string): string {
  const base = window.location.pathname.replace(/\/index\.html?$/i, '/').replace(/\/+$/, '')
  return base ? `${base}${path}` : path
}

export type StoredSession = { token: string; username: string; gateway: string }

/** dev 环境没有这个接口，失败就返回 null，不影响使用。 */
export async function loadSessionFile(): Promise<StoredSession | null> {
  try {
    const res = await fetch(localApi(SESSION_PATH), { cache: 'no-store' })
    if (!res.ok) return null
    const data = (await res.json()) as Partial<StoredSession>
    if (!data?.token) return null
    return {
      token: String(data.token),
      username: String(data.username ?? ''),
      gateway: String(data.gateway ?? ''),
    }
  } catch {
    return null
  }
}

export async function saveSessionFile(session: StoredSession): Promise<void> {
  try {
    await fetch(localApi(SESSION_PATH), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(session),
    })
  } catch {
    /* 写不进去不影响本次登录 */
  }
}

export async function clearSessionFile(): Promise<void> {
  try {
    await fetch(localApi(SESSION_PATH), { method: 'DELETE' })
  } catch {
    /* 忽略 */
  }
}

// ---------- 本机身份 + 认领 ----------

export type LocalDevice = { id: string; name: string; token: string }

/** 本机设备身份（来自 exe 的 settings.json）。dev/手机环境没有这个接口，返回 null。 */
export async function localDevice(): Promise<LocalDevice | null> {
  try {
    const res = await fetch(localApi('/local/account/device'), { cache: 'no-store' })
    if (!res.ok) return null
    const data = (await res.json()) as Partial<LocalDevice>
    if (!data?.id || !data?.token) return null
    return { id: String(data.id), name: String(data.name ?? ''), token: String(data.token) }
  } catch {
    return null
  }
}

/**
 * 把本机认领到当前账号下（登录后自动调用）。
 *
 * exe 自己就是一台电脑，带着 remoteToken（所有权证明），登录即登记，
 * 不再需要 pair.ps1 的配对码。口径是「谁登录就归谁」：同一个 token 换个账号登录，
 * 归属直接转移，不会因为「已被别人绑定」而拒绝（那样会导致换号后看不到自己的电脑）。
 */
export async function claimDevice(
  base: string,
  token: string,
  device: LocalDevice,
): Promise<{ id: string; name: string; owner: string; port: number }> {
  // port 是网关分给这台设备的回环端口，sshd 在那上面 -R 回本机 17800。
  // 拿回来要让 exe 建隧道 —— 否则「登录了但网页端连不过来」（离线）。
  return request<{ id: string; name: string; owner: string; port: number }>(
    base,
    '/portal/api/claim',
    { method: 'POST', body: JSON.stringify(device) },
    token,
  )
}

/**
 * 把隧道端口交给 exe：写进 settings.json 并立刻重建隧道。
 *
 * 失败不抛错：隧道建不起来只影响「远端能不能连进来」，不该挡住登录本身。
 */
export async function setTunnelPort(port: number): Promise<void> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return
  try {
    await fetch(localApi('/local/account/tunnel'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relayPort: port }),
    })
  } catch {
    // 忽略：下次启动 exe 仍会按 settings.json 里的旧值重试
  }
}

/**
 * 让 exe 自动把 ssh 配好（生成密钥 → 上传公钥给网关 → 写 ~/.ssh/config）。
 *
 * 幂等：已经配好的电脑会立刻返回「已配置」。失败也只影响「远端能不能连进来」，
 * 不抛错、不打断登录。
 */
export async function setupTunnel(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(localApi('/local/account/tunnel/setup'), { method: 'POST' })
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
    return (await res.json()) as { ok: boolean; message: string }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/** 本机隧道的状态（给界面显示「为什么没连上」）。 */
export type TunnelStatus = {
  running: boolean
  pid: number
  host: string
  relayPort: number
  localPort: number
  /** ssh 失败的原始原因，已经由外壳翻译成人话；正常时为 null。 */
  error: string | null
}

export async function tunnelStatus(): Promise<TunnelStatus | null> {
  try {
    const res = await fetch(localApi('/local/account/tunnel'), { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as TunnelStatus
  } catch {
    return null
  }
}

// ---------- 请求 ----------

async function request<T>(base: string, path: string, init?: RequestInit, token?: string): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  if (token) headers.set('authorization', `Bearer ${token}`)
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(`${base}${path}`, { ...init, headers, signal: controller.signal })
    const text = await res.text()
    if (!res.ok) {
      let message = `${res.status}`
      try {
        const parsed = JSON.parse(text) as { error?: string }
        if (parsed?.error) message = parsed.error
      } catch {
        /* 非 JSON 就把状态码抛出去 */
      }
      throw new Error(message)
    }
    return (text ? JSON.parse(text) : undefined) as T
  } catch (err) {
    // fetch 自己抛的是英文（Failed to fetch / The user aborted a request），
    // 直接显示给用户既看不懂，也分不清「地址写错」还是「网太慢」。
    if ((err as Error).name === 'AbortError') throw new Error('请求超时：网关地址或网络不通')
    if (err instanceof TypeError) throw new Error('连不上网关，检查地址和网络')
    throw err
  } finally {
    window.clearTimeout(timer)
  }
}

export async function gatewayLogin(
  base: string,
  username: string,
  password: string,
): Promise<{ token: string; username: string }> {
  return request<{ token: string; username: string }>(base, '/portal/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export async function gatewayDevices(
  base: string,
  token: string,
): Promise<{ username: string; devices: GatewayDevice[]; token?: string }> {
  const data = await request<{ username: string; devices: GatewayDevice[]; token?: string }>(
    base,
    '/portal/api/devices',
    undefined,
    token,
  )
  return { username: data.username, devices: data.devices ?? [], token: data.token }
}

/** 设备打开地址：网关相对路径拼成完整 URL。 */
export function deviceUrl(base: string, device: GatewayDevice): string {
  return `${base.replace(/\/+$/, '')}${device.url}`
}
