/**
 * 启动时通过 IPC 向外壳索取 /api 令牌。
 *
 * 约定（与 Rust 外壳一致）：
 *   1. 页面挂载后调用 window.ipc.postMessage('oc:auth')；
 *   2. 外壳收到后用 evaluate_script 下发 window.__ocIpc('token:<随机token>')；
 *   3. 收到后写进 window.__OC_TOKEN，之后所有 /api 请求带 x-oc-token 头。
 *
 * 令牌只走 IPC，不经过 HTTP：index.html 里不再注入任何 token，本机其它进程
 * 也就无法靠 GET / 拿到门禁。3 秒内没拿到令牌视为「连接本地服务失败」，
 * 但界面照常渲染，且**自己退避重试**（见 RETRY_DELAYS_MS）——外壳比页面晚就绪
 * 是常态，不能把用户钉在「未连接」上等他点「重试」。
 *
 * Vite dev 模式没有外壳 IPC：直接置为 ready、token 用空串，交给 Vite 自己的
 * cookie 代理，行为和改造前一致。
 */

import { remoteTokenKey } from './base.ts'

type WindowWithIpc = Window & {
  ipc?: { postMessage(message: string): void }
  __OC_TOKEN?: string
  __ocIpc?: (message: string) => void
}

export type AuthState =
  | { status: 'pending'; token: '' }
  | { status: 'ready'; token: string }
  | { status: 'failed'; token: ''; error: string }

const AUTH_MESSAGE = 'oc:auth'
const TOKEN_PREFIX = 'token:'
const AUTH_TIMEOUT_MS = 3000
/**
 * 握手失败后的自动重试退避（毫秒）。
 *
 * 页面经常比外壳的 IPC 桥先就绪：`ipc` 还没注入、`__ocIpc` 被外壳晚一步装上、
 * 或者第一次 `oc:auth` 恰好落在渲染进程刚起来的那几百毫秒里丢了。
 * 以前 3 秒超时就把界面钉死在「未连接」，只能靠用户点一次「重试」；
 * 现在自己退避重试，前几次要快到用户感知不到（150ms 级），稳定后 2 秒一次。
 */
const RETRY_DELAYS_MS = [150, 300, 600, 1200, 2000]
/**
 * 等令牌期间补发 `oc:auth` 的间隔。
 *
 * 外壳对 `oc:auth` 是幂等的（每次都会再下发同一个令牌，页面重载也允许重复索取），
 * 而 WebView2 的消息泵在页面刚起来那几百毫秒里偶尔会丢一条。只发一次就得等满
 * 3 秒超时才能重来，实测「第一次丢了」要 6.5 秒才连上；每 0.7 秒补一条能压到 1 秒内。
 */
const NUDGE_INTERVAL_MS = 700
export const AUTH_FAILED_TEXT = '连接本地服务失败'

const INITIAL: AuthState = { status: 'pending', token: '' }

let state: AuthState = INITIAL
let started = false
let timer: number | null = null
// 自动重试的定时器与步数：握手失败后自己排下一次，见 scheduleRetry。
let retryTimer: number | null = null
let retryStep = 0
// 等令牌期间补发 oc:auth 的定时器，见 startNudge。
let nudgeTimer: number | null = null
// 外壳可能已经装过 __ocIpc（例如 pong 处理器），非 token 消息要继续转交给它
let baseIpc: ((message: string) => void) | undefined
// 我们自己装上去的处理函数：重试时据此还原 baseIpc，避免把旧 handler 链成一层套一层
let installedIpc: ((message: string) => void) | undefined
const listeners = new Set<() => void>()
// 非 token 消息（例如 folder:...）的订阅者
const ipcListeners = new Set<(message: string) => void>()

function emit(next: AuthState) {
  state = next
  for (const listener of listeners) listener()
}

/** 给 useSyncExternalStore 用：状态对象只在变化时替换，引用保持稳定。 */
export function getAuthState(): AuthState {
  return state
}

/** 订阅非 token 的 IPC 消息（例如选文件夹的 folder:<path>）。返回取消函数。 */
export function onIpcMessage(fn: (message: string) => void): () => void {
  ipcListeners.add(fn)
  return () => {
    ipcListeners.delete(fn)
  }
}

export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 停掉补发：拿到令牌、或者这次握手已经判定失败，都不该继续敲外壳。 */
function stopNudge(): void {
  if (nudgeTimer !== null) {
    window.clearInterval(nudgeTimer)
    nudgeTimer = null
  }
}

/** 等令牌期间每隔 [`NUDGE_INTERVAL_MS`] 再要一次（外壳侧幂等，重复索取无害）。 */
function startNudge(): void {
  if (nudgeTimer !== null) return
  nudgeTimer = window.setInterval(() => {
    if (state.status !== 'pending') {
      stopNudge()
      return
    }
    const ipc = (window as WindowWithIpc).ipc
    ipc?.postMessage(AUTH_MESSAGE)
  }, NUDGE_INTERVAL_MS)
}

/** 取消已排队的自动重试（握手成功后调用），并把退避步数归零。 */
function clearRetry(): void {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer)
    retryTimer = null
  }
  retryStep = 0
  stopNudge()
}

/**
 * 握手失败后排下一次自动重试。
 *
 * 只在「还没拿到令牌」时有用：令牌一到 [`clearRetry`] 就把这串计时器拆掉。
 * 完全没有外壳时（例如在浏览器里打开打包产物）会一直退避到 2 秒一次，
 * 每次只是一条 postMessage，代价可以忽略；换来的是外壳晚就绪时能自己恢复，
 * 不用用户去点「重试」。
 */
function scheduleRetry(): void {
  if (retryTimer !== null) return
  const delay = RETRY_DELAYS_MS[Math.min(retryStep, RETRY_DELAYS_MS.length - 1)]
  retryStep += 1
  retryTimer = window.setTimeout(() => {
    retryTimer = null
    if (state.status === 'ready') return
    handshake()
  }, delay)
}

/** 真正发起一次握手；startAuth（首次）与 retryAuth（重试）都走这里。 */
/**
 * 浏览器/远程访问：把入口 `?t=` 里的凭据存进 localStorage，并把 URL 里的 t 去掉。
 *
 * 为什么不只靠 cookie：手机上（尤其微信内置浏览器）经常存不住，
 * 表现为页面能打开但所有 `/api` 都 403。localStorage 同源稳定，还能保留 30 天。
 */
function captureRemoteToken(): void {
  try {
    const url = new URL(window.location.href)
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''))
    const token = url.searchParams.get('t') || hashParams.get('t')
    if (!token) return
    window.localStorage.setItem(remoteTokenKey(), token)
    url.searchParams.delete('t')
    hashParams.delete('t')
    url.hash = hashParams.toString() ? '#' + hashParams.toString() : ''
    window.history.replaceState(null, '', url.pathname + (url.search || '') + (url.hash || ''))
  } catch {
    // 存储不可用时继续走 cookie
  }
}

function handshake(): void {
  const w = window as WindowWithIpc

  // Vite dev server：没有 window.ipc，也没有本地外壳，token 走空串。
  if (import.meta.env.DEV) {
    clearRetry()
    emit({ status: 'ready', token: '' })
    return
  }

  // 这次是手动或自动重试发起的：先撤掉排队中的那一次，避免两次握手叠在一起。
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer)
    retryTimer = null
  }

  const ipc = w.ipc
  if (!ipc?.postMessage) {
    // 浏览器（远程访问）里没有 WebView2 的 IPC 桥，但入口已经用小票换过 cookie，
    // 鉴权由 cookie 完成。这里必须直接判 ready：否则会一直显示「连接本地服务失败」，
    // 用户还以为服务没起来。用 chrome.webview 区分「外壳还没就绪」和「根本没有外壳」。
    const isWebView = Boolean((window as { chrome?: { webview?: unknown } }).chrome?.webview)
    if (!isWebView) {
      captureRemoteToken()
      clearRetry()
      emit({ status: 'ready', token: '' })
      return
    }
    // 外壳的 IPC 桥还没注入（页面先于桥就绪）：保持失败态但别停，退避后再要一次。
    stopNudge()
    if (state.status !== 'failed') emit({ status: 'failed', token: '', error: AUTH_FAILED_TEXT })
    scheduleRetry()
    return
  }

  // 只在第一次（或外部把 __ocIpc 换掉时）记住外壳原有处理函数
  if (w.__ocIpc && w.__ocIpc !== installedIpc) baseIpc = w.__ocIpc
  const previous = baseIpc

  if (timer !== null) window.clearTimeout(timer)
  const mine = window.setTimeout(() => {
    if (timer !== mine) return
    timer = null
    stopNudge()
    if (state.status === 'pending') emit({ status: 'failed', token: '', error: AUTH_FAILED_TEXT })
    // 令牌没来就自己再要：外壳晚起、消息被丢、渲染进程刚恢复都能靠这一下接上。
    if (state.status !== 'ready') scheduleRetry()
  }, AUTH_TIMEOUT_MS)
  timer = mine

  const handler = (message: string) => {
    if (typeof message === 'string' && message.startsWith(TOKEN_PREFIX)) {
      const token = message.slice(TOKEN_PREFIX.length)
      if (timer === mine) {
        window.clearTimeout(timer)
        timer = null
      }
      // 拿到令牌就不再自动重试；超时之后才到的令牌同样认（从 failed 恢复成 ready）。
      clearRetry()
      w.__OC_TOKEN = token
      if (state.status !== 'ready' || state.token !== token) emit({ status: 'ready', token })
      return
    }
    // 其它消息（folder:<path> / root:<path>）先分发给订阅者，再交给外壳原有处理函数。
    for (const fn of ipcListeners) {
      try {
        fn(message)
      } catch (err) {
        console.error('IPC 消息处理失败', err)
      }
    }
    try {
      previous?.(message)
    } catch (err) {
      console.error('外壳 IPC 处理器失败', err)
    }
  }
  installedIpc = handler
  w.__ocIpc = handler

  ipc.postMessage(AUTH_MESSAGE)
  // 外壳可能还没把消息泵转起来：等令牌期间自己补发，别把恢复时间交给 3 秒超时。
  startNudge()
}

/** 幂等：StrictMode 双挂载 / 多处调用都只会握手一次。 */
export function startAuth(): void {
  if (started) return
  started = true
  handshake()
}

/**
 * 重新走一次 IPC 握手，返回握手结束后的状态。
 *
 * 用途：auth.status === 'failed'（3 秒内没收到令牌）时点「重试」。这种状态下
 * 连令牌都没有，直接请求 /api/reconnect 必然 403，所以必须先重新握手。
 * 令牌到达或再次超时后 resolve，不会永久挂住。
 */
export function retryAuth(): Promise<AuthState> {
  if (!started) {
    startAuth()
  } else if (!import.meta.env.DEV) {
    // 回到 pending，界面显示「连接中…」；随后重新发 oc:auth
    emit({ ...INITIAL })
    handshake()
  }

  if (state.status !== 'pending') return Promise.resolve(state)

  return new Promise((resolve) => {
    const listener = () => {
      if (state.status === 'pending') return
      listeners.delete(listener)
      resolve(state)
    }
    listeners.add(listener)
  })
}
