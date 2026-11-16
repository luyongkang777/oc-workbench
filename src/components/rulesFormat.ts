/**
 * 强制规则的类型与纯函数。
 *
 * 规则是**条目**，不是一整块正文：
 *   * 单行条目：只有内容
 *   * 两行条目：标题 + 内容
 *
 * 单独成文件（不 import client）是为了能在 Node 单测里直接跑。
 * 规则没有开关：数据结构里没有 enabled，清空全部条目才是取消约束。
 */

export type RuleItem = {
  /** 标题；空串表示单行条目 */
  title: string
  /** 内容（必填，空内容会被丢弃） */
  text: string
}

export type RuleScope = 'global' | 'local'

export type RuleSource = {
  scope: RuleScope
  path: string
  exists: boolean
  bytes: number
  mtimeMs: number | null
  /** 文件存在但读不出来 / 解析失败的原因 */
  error: string | null
  items: RuleItem[]
  /** 从老的整块 .md 读出来的（第一次保存时迁移） */
  migratedFrom: string
}

export type RulesStatus = {
  ok: boolean
  directory: string
  global: RuleSource
  local: RuleSource
  /** 两级条目总数 > 0 */
  active: boolean
  totalItems: number
  readErrors: number
  pluginInstalled: boolean
  pluginDir: string
  dataDir: string
  maxBytes: number
  maxItems?: number
}

/** 只有空白的内容不算一条规则。 */
export function normalizeItems(raw: unknown): RuleItem[] {
  if (!Array.isArray(raw)) return []
  const out: RuleItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const text = String(record.text ?? '').trim()
    if (!text) continue
    const title = String(record.title ?? '').trim()
    out.push({ title, text })
  }
  return out
}

/** 编辑态的行：允许空内容（输入到一半），保存时再归一化。 */
export type RuleDraft = { title: string; text: string }

export function toDrafts(items: RuleItem[]): RuleDraft[] {
  return items.map((item) => ({ title: item.title, text: item.text }))
}

/**
 * 规则覆盖情况的短描述。
 *
 * 强制层没有开关，所以只说「覆盖了哪几级、共几条」，绝不说「开/关」。
 */
export function coverageText(status: RulesStatus | null): string {
  if (!status) return '规则：读取中'
  if (status.readErrors > 0) return '规则：有文件读不出来（写操作会被拦）'
  const levels: string[] = []
  if (status.global.items.length) levels.push('全局')
  if (status.local.items.length) levels.push('目录')
  if (!levels.length) return '规则：没有条目，当前没有任何约束'
  return `规则：已强制生效（${levels.join(' + ')}，共 ${status.totalItems} 条）`
}
