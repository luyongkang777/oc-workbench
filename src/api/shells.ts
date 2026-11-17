import { authToken, withBase } from './base.ts'

/**
 * 后台命令（shell）接口：opencode 服务端把模型/用户在某个目录下跑的命令
 * 统一登记为 shell 会话，输出落到文件、可按字节游标分页读。
 *
 * 注意：`GET /api/shell` 只返回**正在跑**的命令，跑完就消失。
 * 想知道某条跑完了没有，要用 `getShell` 按 id 查（能拿到 exited + 退出码）。
 */

export type ShellStatus = 'running' | 'exited' | 'timeout' | 'killed'

export type ShellInfo = {
  id: string
  status: ShellStatus
  command: string
  cwd: string
  shell: string
  /** 合并输出落盘的文件路径（服务端内部用，前端只展示） */
  file: string
  pid: number
  exit?: number
  signal?: string
  /** 实测带 `sessionID`：标明这条命令属于哪个会话 */
  metadata?: Record<string, unknown>
  time: { started: number; completed?: number }
}

/** 命令已经被删除（不是网络错误）。调用方要能区分，否则会把抖动当成「跑完了」。 */
export class ShellGoneError extends Error {
  constructor(message = '这条命令已经不在了（可能被别处清理）') {
    super(message)
    this.name = 'ShellGoneError'
  }
}

export type ShellOutput = {
  text: string
  /** 是否因为页数上限没读全 */
  truncated: boolean
}

/** 一次性最多读这么多页 × 128KB ≈ 1MB，防止日志爆炸。 */
const READ_LIMIT = 131072
const MAX_PAGES = 8

function loc(root: string): string {
  return `location%5Bdirectory%5D=${encodeURIComponent(root)}`
}

async function req(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const current = authToken()
  if (current) headers.set('x-oc-token', current)
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return fetch(withBase(path), { ...init, headers })
}

/** 当前目录下**正在跑**的命令（已退出的服务端不返回）。 */
export async function listShells(root: string): Promise<ShellInfo[]> {
  const res = await req(`/api/shell?${loc(root)}`)
  if (!res.ok) throw new Error(`读取后台命令失败：${res.status}`)
  const json = (await res.json()) as { data?: ShellInfo[] }
  return json.data ?? []
}

/**
 * 单条命令的状态。跑完的命令虽然不在列表里，这里仍然能查到
 * （返回 status=exited 和退出码）；命令被删掉时返回 null。
 */
export async function getShell(id: string, root: string): Promise<ShellInfo | null> {
  const res = await req(`/api/shell/${encodeURIComponent(id)}?${loc(root)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`读取命令状态失败：${res.status}`)
  const json = (await res.json()) as { data?: ShellInfo }
  return json.data ?? null
}

/**
 * 读合并输出。服务端按字节游标分页，`truncated` 为真就带着 `cursor` 继续读。
 * 超过页数上限时返回 truncated=true，调用方应该提示「输出已截断」。
 */
export async function readShellOutput(id: string, root: string): Promise<ShellOutput> {
  let text = ''
  let cursor: string | null = null
  let truncated = false

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = `${loc(root)}&limit=${READ_LIMIT}${cursor ? `&cursor=${cursor}` : ''}`
    const res = await req(`/api/shell/${encodeURIComponent(id)}/output?${query}`)
    if (res.status === 404) throw new ShellGoneError()
    if (!res.ok) throw new Error(`读取输出失败：${res.status}`)
    const json = (await res.json()) as {
      data?: { output?: string; cursor?: number | string; truncated?: boolean }
    }
    const data = json.data
    if (!data) break
    text += data.output ?? ''
    truncated = Boolean(data.truncated)
    if (!truncated) break
    // cursor 的类型服务端没有契约保证，数字和字符串都认
    const next = data.cursor == null ? null : String(data.cursor)
    if (!next || next === cursor) break
    cursor = next
  }

  return { text, truncated }
}

/** 终止并移除一条命令（含保留的输出文件）。命令已经不在了也算成功。 */
export async function killShell(id: string, root: string): Promise<void> {
  const res = await req(`/api/shell/${encodeURIComponent(id)}?${loc(root)}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw new Error(`终止命令失败：${res.status}`)
}
