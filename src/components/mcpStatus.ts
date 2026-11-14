/**
 * MCP 服务器状态（GET /api/mcp）→ 输入框统计条上的读数。
 *
 * 后端 status 枚举：connected / pending / disabled / failed / needs_auth。
 * 这里只做三件事：清洗未知值、按「异常优先」排序、算数量与文案。
 * 与 UI 无关，给 SessionStatsBar 和回归测试共用。
 */

/** 后端可能返回的状态；未知值统一收成 'unknown'（不让一个坏字段毁掉整块面板）。 */
export type McpStatus = 'connected' | 'pending' | 'disabled' | 'failed' | 'needs_auth' | 'unknown'

export type McpServerInfo = {
  name: string
  title?: string
  status: McpStatus
  /** failed / needs_auth 才有；展示时截断，完整内容进 title */
  error?: string
}

export type McpSummary = {
  total: number
  connected: number
  failed: number
  pending: number
  disabled: number
  needsAuth: number
  /** 需要用户处理的个数：失败 + 需授权（连接中不算坏，只是还没好） */
  broken: number
}

/** 状态灯的语义档位，对齐 base.css 的 .status-dot ok/pending/bad。 */
export type McpTone = 'ok' | 'pending' | 'bad' | 'muted'

const KNOWN: ReadonlySet<string> = new Set([
  'connected',
  'pending',
  'disabled',
  'failed',
  'needs_auth',
])

/** 把后端一条记录压成界面要的形状；没有 name 的直接丢掉。 */
function normalizeOne(raw: unknown): McpServerInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as { name?: unknown; title?: unknown; status?: unknown }
  if (typeof source.name !== 'string' || !source.name) return null

  const statusRaw =
    source.status && typeof source.status === 'object'
      ? (source.status as { status?: unknown; error?: unknown })
      : undefined
  const label = typeof statusRaw?.status === 'string' ? statusRaw.status : ''
  const status = (KNOWN.has(label) ? label : 'unknown') as McpStatus
  const error = typeof statusRaw?.error === 'string' ? statusRaw.error : undefined

  return {
    name: source.name,
    title: typeof source.title === 'string' ? source.title : undefined,
    status,
    error: error || undefined,
  }
}

export function normalizeMcpServers(raw: unknown): McpServerInfo[] {
  if (!Array.isArray(raw)) return []
  const list: McpServerInfo[] = []
  for (const item of raw) {
    const server = normalizeOne(item)
    if (server) list.push(server)
  }
  return list
}

export function summarizeMcp(servers: McpServerInfo[]): McpSummary {
  const summary: McpSummary = {
    total: servers.length,
    connected: 0,
    failed: 0,
    pending: 0,
    disabled: 0,
    needsAuth: 0,
    broken: 0,
  }
  for (const server of servers) {
    switch (server.status) {
      case 'connected':
        summary.connected += 1
        break
      case 'failed':
        summary.failed += 1
        break
      case 'pending':
        summary.pending += 1
        break
      case 'disabled':
        summary.disabled += 1
        break
      case 'needs_auth':
        summary.needsAuth += 1
        break
      default:
        // 未知状态当作坏掉：宁可提示一句，也别让它静默混进「已连接」里
        summary.failed += 1
        break
    }
  }
  summary.broken = summary.failed + summary.needsAuth
  return summary
}

/** 统计条上的短读数：`MCP 8/30`；一个都没有时返回空串（不显示占位）。 */
export function mcpChipLabel(summary: McpSummary): string {
  if (summary.total === 0) return ''
  return `MCP ${summary.connected}/${summary.total}`
}

/** 悬停提示：一句话说清「几个连上、几个没连上」。 */
export function mcpChipTitle(summary: McpSummary): string {
  if (summary.total === 0) return '没有配置 MCP 服务器'
  const parts = [`已连接 ${summary.connected}/${summary.total}`]
  if (summary.failed > 0) parts.push(`失败 ${summary.failed}`)
  if (summary.needsAuth > 0) parts.push(`需授权 ${summary.needsAuth}`)
  if (summary.pending > 0) parts.push(`连接中 ${summary.pending}`)
  if (summary.disabled > 0) parts.push(`已停用 ${summary.disabled}`)
  return `MCP 服务器：${parts.join(' · ')}`
}

export function mcpStatusText(status: McpStatus): string {
  switch (status) {
    case 'connected':
      return '已连接'
    case 'pending':
      return '连接中'
    case 'disabled':
      return '已停用'
    case 'needs_auth':
      return '需要授权'
    case 'failed':
      return '连接失败'
    default:
      return '状态未知'
  }
}

export function mcpTone(status: McpStatus): McpTone {
  switch (status) {
    case 'connected':
      return 'ok'
    case 'pending':
      return 'pending'
    case 'failed':
    case 'needs_auth':
      return 'bad'
    default:
      return 'muted'
  }
}

/**
 * 排序：坏的排最前面（失败 → 需授权），再连接中，最后才连上的。
 *
 * 用户展开面板就是为了看「哪个没连上」，先翻二十多个「已连接」找一条失败
 * 跟没展开没区别。组内按名字排，顺序稳定、不会每次刷新乱跳。
 */
const ORDER: Record<McpStatus, number> = {
  failed: 0,
  needs_auth: 1,
  unknown: 2,
  pending: 3,
  connected: 4,
  disabled: 5,
}

export function sortMcpServers(servers: McpServerInfo[]): McpServerInfo[] {
  return [...servers].sort((left, right) => {
    const byOrder = ORDER[left.status] - ORDER[right.status]
    if (byOrder !== 0) return byOrder
    return left.name.localeCompare(right.name)
  })
}

/**
 * 错误原文 → 一句中文摘要。
 *
 * 几十个 MCP 里连不上的往往是同一类原因（服务没起、端口不对），
 * 面板上重复二十遍英文原文既吵又看不懂；原文仍然保留在 title 里。
 */
export function mcpErrorHint(error: string | undefined): string {
  if (!error) return ''
  const text = error.trim()
  if (/ECONNREFUSED/i.test(text)) return '连不上：目标端口没有在监听'
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return '域名解析失败'
  if (/ETIMEDOUT|timed?\s?out|timeout/i.test(text)) return '连接超时'
  if (/ECONNRESET|socket hang up|EPIPE/i.test(text)) return '连接被对端断开'
  if (/\b(401|403)\b|unauthor|forbidden/i.test(text)) return '需要授权或令牌失效'
  if (/certificate|self.signed|SSL|TLS/i.test(text)) return '证书校验失败'
  return shortMcpError(text)
}

/** 错误原文压成一行短句：面板一行放不下，完整内容由调用方放进 title。 */
export function shortMcpError(error: string | undefined): string {
  if (!error) return ''
  const one = error.replace(/\s+/g, ' ').trim()
  return one.length > 90 ? `${one.slice(0, 89)}…` : one
}
