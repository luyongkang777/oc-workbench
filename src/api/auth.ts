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
const listeners = new Set<() => void>()

function emit(next: AuthState) {
  state = next
  for (const listener of listeners) listener()
}

/** 给 useSyncExternalStore 用：状态对象只在变化时替换，引用保持稳定。 */
export function getAuthState(): AuthState {
  return state
}

export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 幂等：StrictMode 双挂载 / 多处调用都只会握手一次。 */
export function startAuth(): void {
  if (started) return
  started = true

  // Vite dev server：没有 window.ipc，也没有本地外壳，token 走空串。
  if (import.meta.env.DEV) {
    emit({ status: 'ready', token: '' })
    return
  }

  const w = window as WindowWithIpc
  if (!w.ipc?.postMessage) {
    emit({ status: 'failed', token: '', error: AUTH_FAILED_TEXT })
    return
  }

  // __ocIpc 可能已经被外壳初始化脚本装过：保留它，非 token 消息继续转交。
  const previous = w.__ocIpc
  const ipc = w.ipc

  const timer = window.setTimeout(() => {
    if (state.status === 'pending') emit({ status: 'failed', token: '', error: AUTH_FAILED_TEXT })
  }, AUTH_TIMEOUT_MS)

  w.__ocIpc = (message: string) => {
    if (typeof message === 'string' && message.startsWith(TOKEN_PREFIX)) {
      const token = message.slice(TOKEN_PREFIX.length)
      window.clearTimeout(timer)
      w.__OC_TOKEN = token
      // 超时之后才到的令牌同样认：从 failed 恢复成 ready。
      if (state.status !== 'ready' || state.token !== token) emit({ status: 'ready', token })
      return
    }
    // 其它消息（pong:<msg>）目前没有消费方，原样交给先前安装的处理函数。
    previous?.(message)
  }

  ipc.postMessage(AUTH_MESSAGE)
}
