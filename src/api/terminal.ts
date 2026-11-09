import { WORKBENCH_SOURCE } from './chat'

/** 终端（T6）：在指定会话下创建一次性 PTY，轮询 snapshot 拿输出。 */

export type TerminalSnapshot = {
  text: string
  status: string
  exitCode?: number
}

function token(): string {
  return (window as unknown as { __OC_TOKEN?: string }).__OC_TOKEN ?? ''
}

function loc(root: string): string {
  return `location%5Bdirectory%5D=${encodeURIComponent(root)}`
}

async function req(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const current = token()
  if (current) headers.set('x-oc-token', current)
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(path, { ...init, headers })
}

const SESSION_KEY = 'oc-workbench:terminal-session'

/** 终端命令挂在一个专用会话下；找不到就重建。 */
export async function ensureTerminalSession(root: string): Promise<string> {
  const cached = window.localStorage.getItem(SESSION_KEY)
  if (cached) {
    const probe = await req(`/api/session/${encodeURIComponent(cached)}`)
    if (probe.ok) return cached
    window.localStorage.removeItem(SESSION_KEY)
  }

  const res = await req('/api/session', {
    method: 'POST',
    // 打上工作台标记并标明是终端会话：下拉列表不会把它当用户会话或外部会话列出
    body: JSON.stringify({
      title: '工作台终端',
      location: { directory: root },
      metadata: { source: WORKBENCH_SOURCE, kind: 'terminal' },
    }),
  })
  if (!res.ok) throw new Error(`创建终端会话失败：${res.status} ${await res.text()}`)
  const json = (await res.json()) as { data?: { id?: string } }
  const id = json.data?.id
  if (!id) throw new Error('创建终端会话失败：响应里没有 id')
  window.localStorage.setItem(SESSION_KEY, id)
  return id
}

/** 执行一条命令，返回 pty id。命令用 cmd.exe /c 包一层，跑完自动退出。 */
export async function runInTerminal(
  sessionID: string,
  root: string,
  command: string,
): Promise<string> {
  const res = await req(`/api/experimental/session/${encodeURIComponent(sessionID)}/terminal?${loc(root)}`, {
    method: 'POST',
    body: JSON.stringify({
      command: 'cmd.exe',
      args: ['/c', command],
      cwd: root,
      title: command.slice(0, 40) || 'terminal',
      env: {},
      size: { rows: 24, cols: 100 },
    }),
  })
  if (!res.ok) throw new Error(`启动命令失败：${res.status} ${await res.text()}`)
  const json = (await res.json()) as { data?: { id?: string } }
  const id = json.data?.id
  if (!id) throw new Error('启动命令失败：响应里没有 pty id')
  return id
}

export async function readTerminal(ptyID: string): Promise<TerminalSnapshot> {
  const res = await req(`/api/experimental/persistent-pty/${encodeURIComponent(ptyID)}/snapshot`)
  if (!res.ok) throw new Error(`读取终端输出失败：${res.status}`)
  const json = (await res.json()) as {
    data?: {
      text?: string
      info?: { status?: string; exitCode?: number }
    }
  }
  return {
    text: json.data?.text ?? '',
    status: json.data?.info?.status ?? 'unknown',
    exitCode: json.data?.info?.exitCode,
  }
}

export async function removeTerminal(ptyID: string): Promise<void> {
  await req(`/api/experimental/persistent-pty/${encodeURIComponent(ptyID)}`, { method: 'DELETE' })
}
