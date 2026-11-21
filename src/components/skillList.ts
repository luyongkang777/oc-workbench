/**
 * 技能清单（`GET /api/skill`）→ 管理面板用的结构化列表。
 *
 * 接口返回的每条带完整 `content`（本机实测 155 条共约 1.5 MB），
 * 面板只展示元数据，所以在这里就把正文丢掉，别留在内存里。
 */

export type SkillInfo = {
  id: string
  name: string
  description: string
  path: string
  /** 所在目录名（如 opencode / workbench），只用于展示来源，不参与任何判断 */
  source: string
}

type RawSkill = {
  id?: unknown
  name?: unknown
  description?: unknown
  path?: unknown
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 从 SKILL.md 的完整路径推出所属目录名；拿不到就回空串。 */
export function skillSource(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]+/)
  // 最后一段是 SKILL.md，倒数第二段才是技能目录
  const dir = parts.length >= 2 ? parts[parts.length - 2] : ''
  return dir === 'skills' ? '' : dir
}

/**
 * 清洗接口结果：兼容 `[...]` 和 `{data: [...]}` 两种外形，丢掉无名条目，
 * 同一 id 只留第一条，按名字排序。
 */
export function normalizeSkills(raw: unknown): SkillInfo[] {
  const list = Array.isArray(raw) ? raw : (raw as { data?: unknown } | null)?.data
  if (!Array.isArray(list)) return []

  const seen = new Set<string>()
  const out: SkillInfo[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as RawSkill
    const id = text(record.id)
    const name = text(record.name) || id
    if (!name) continue
    const key = id || name
    if (seen.has(key)) continue
    seen.add(key)
    const path = text(record.path)
    out.push({
      id: key,
      name,
      description: text(record.description),
      path,
      source: skillSource(path),
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 按名字 / 描述 / 路径过滤（大小写不敏感）；空查询返回原列表。 */
export function filterSkills(list: SkillInfo[], query: string): SkillInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter(
    (skill) =>
      skill.name.toLowerCase().includes(q) ||
      skill.description.toLowerCase().includes(q) ||
      skill.path.toLowerCase().includes(q),
  )
}
