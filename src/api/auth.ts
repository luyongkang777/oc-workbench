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
 * 但界面照常渲染，且之后令牌补到仍会恢复。
 *
 * Vite dev 模式没有外壳 IPC：直接置为 ready、token 用空串，交给 Vite 自己的
 * cookie 代理，行为和改造前一致。
 */

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
export const AUTH_FAILED_TEXT = '连接本地服务失败'

const INITIAL: AuthState = { status: 'pending', token: '' }

let state: AuthState = INITIAL
let started = false
let timer: number | null = null
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

/** 真正发起一次握手；startAuth（首次）与 retryAuth（重试）都走这里。 */
function handshake(): void {
  const w = window as WindowWithIpc

  // Vite dev server：没有 window.ipc，也没有本地外壳，token 走空串。
  if (import.meta.env.DEV) {
    emit({ status: 'ready', token: '' })
    return
  }

  const ipc = w.ipc
  if (!ipc?.postMessage) {
    emit({ status: 'failed', token: '', error: AUTH_FAILED_TEXT })
    return
  }

  // 只在第一次（或外部把 __ocIpc 换掉时）记住外壳原有处理函数
  if (w.__ocIpc && w.__ocIpc !== installedIpc) baseIpc = w.__ocIpc
  const previous = baseIpc

  if (timer !== null) window.clearTimeout(timer)
  const mine = window.setTimeout(() => {
    if (timer !== mine) return
    timer = null
    if (state.status === 'pending') emit({ status: 'failed', token: '', error: AUTH_FAILED_TEXT })
  }, AUTH_TIMEOUT_MS)
  timer = mine

  const handler = (message: string) => {
    if (typeof message === 'string' && message.startsWith(TOKEN_PREFIX)) {
      const token = message.slice(TOKEN_PREFIX.length)
      if (timer === mine) {
        window.clearTimeout(timer)
        timer = null
      }
      w.__OC_TOKEN = token
      // 超时之后才到的令牌同样认：从 failed 恢复成 ready。
      if (state.status !== 'ready' || state.token !== token) emit({ status: 'ready', token })
      return
    }
    // 其它消息（pong:<msg>）目前没有消费方，原样交给外壳原有处理函数。
    previous?.(message)
  }
  installedIpc = handler
  w.__ocIpc = handler

  ipc.postMessage(AUTH_MESSAGE)
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
