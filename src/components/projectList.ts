/**
 * 项目清单的纯逻辑：规范化、去重、增删、按最近使用排序、每个项目记住的界面状态。
 *
 * 不碰 window / IPC，方便 node 直接单测；持久化在 api/projects.ts 里做。
 */

/** 每个项目自己记住的界面状态：看到哪个文件、停在代码还是审查面板。 */
export type ProjectState = {
  file?: string | null
  view?: 'code' | 'diff'
}

export type Project = {
  path: string
  name: string
  state?: ProjectState
  /** 毫秒时间戳；越大越近，用于排序 */
  lastUsed?: number
}

/** 清单上限：再多也就没人往下翻了，顺便挡住异常膨胀。 */
export const MAX_PROJECTS = 40

/**
 * 比较用的规范形式：去引号与尾分隔符、正反斜杠统一、转小写。
 * 只用于比较/去重，展示仍用原路径（Windows 下大小写不敏感）。
 */
export function normKey(path: string): string {
  return String(path ?? '')
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()
}

/** 从路径取项目名：最后一段；取不到就用整串。 */
export function projectNameOf(path: string): string {
  const parts = String(path ?? '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter(Boolean)
  const last = parts[parts.length - 1]
  return last && last.length <= 60 ? last : String(path ?? '')
}

/** 容错解析：坏条目丢掉，不因为一条脏数据让整个清单失效。 */
export function parseProjects(raw: unknown): Project[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { projects?: unknown }).projects)
      ? (raw as { projects: unknown[] }).projects
      : []
  const out: Project[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Partial<Project>
    const path = typeof entry.path === 'string' ? entry.path.trim() : ''
    if (!path) continue
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : projectNameOf(path)
    const project: Project = { path, name }
    if (typeof entry.lastUsed === 'number' && Number.isFinite(entry.lastUsed)) project.lastUsed = entry.lastUsed
    const state = entry.state
    if (state && typeof state === 'object') {
      const file = typeof state.file === 'string' && state.file.trim() ? state.file : null
      const view = state.view === 'diff' ? 'diff' : state.view === 'code' ? 'code' : undefined
      if (file || view) project.state = { ...(file ? { file } : { file: null }), ...(view ? { view } : {}) }
    }
    if (out.some((p) => normKey(p.path) === normKey(project.path))) continue
    out.push(project)
  }
  return sortProjects(out)
}

/** 最近用过的排前面；时间相同保持原顺序（sort 稳定）。 */
export function sortProjects(list: Project[]): Project[] {
  return list
    .slice()
    .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))
    .slice(0, MAX_PROJECTS)
}

export function findProject(list: Project[], path: string): Project | undefined {
  const key = normKey(path)
  if (!key) return undefined
  return list.find((p) => normKey(p.path) === key)
}

/**
 * 加入或更新一条：按路径去重（同一个目录只留一条）。
 * 已有条目保留原来的 state / lastUsed，除非 patch 显式给了。
 */
export function upsertProject(list: Project[], path: string, patch?: Partial<Omit<Project, 'path'>>): Project[] {
  const clean = String(path ?? '').trim()
  if (!clean) return list
  const key = normKey(clean)
  const current = list.find((p) => normKey(p.path) === key)
  const next: Project = current
    ? { ...current, ...patch, path: current.path }
    : { path: clean, name: projectNameOf(clean), lastUsed: Date.now(), ...patch }
  if (!current) next.name = patch?.name ?? next.name
  const rest = list.filter((p) => normKey(p.path) !== key)
  return sortProjects([...rest, next])
}

export function removeProject(list: Project[], path: string): Project[] {
  const key = normKey(path)
  if (!key) return list
  return list.filter((p) => normKey(p.path) !== key)
}

/** 记下某个项目的界面状态。找不到就原样返回（可能刚被删掉）。 */
export function setProjectState(list: Project[], path: string, state: ProjectState): Project[] {
  const key = normKey(path)
  if (!key) return list
  let changed = false
  const next = list.map((p) => {
    if (normKey(p.path) !== key) return p
    changed = true
    return { ...p, state: { ...p.state, ...state } }
  })
  return changed ? next : list
}

/** 切到某个项目时把它提到最前（更新 lastUsed）。 */
export function touchProject(list: Project[], path: string): Project[] {
  const key = normKey(path)
  if (!key) return list
  const hit = list.find((p) => normKey(p.path) === key)
  if (!hit) return list
  return sortProjects(list.map((p) => (p === hit ? { ...p, lastUsed: Date.now() } : p)))
}
