import { normKey } from './projectList.ts'

/**
 * 文件定位：打开一个「当前工作区里不存在」的路径时，去更大的范围里找它。
 *
 * 背景：状态栏/工具详情里给的 `.tmp/patch-verify-4.mjs` 不在当前工作区，
 * 查看区直接按当前根拼路径 → `404 文件不存在`，以前只有一个「重试」，
 * 重试还是同一个路径、还是 404，用户只能干看着。
 *
 * 现在按三级作用域依次找（当前工作区 → 上级目录 → 其它已记录项目），
 * 找到就把可点的结果给出来，点一下直接打开。
 *
 * 三级搜索成本递进，顺序不能反：
 *   1. exact   —— 原相对路径直接 stat（最准、最便宜）；
 *   2. basename —— 按文件名找（`find`，浅层优先、跳过 node_modules）；
 *   3. similar —— 在**原目录**里找相似名字（`.tmp/patch-verify-4.mjs` 找不到时，
 *                 `.tmp/patch-verify-1.mjs` 这类同族文件往往还在）。
 *
 * 第 3 级刻意不是「拿整条路径当子串扫全树」：那种搜法既扫得慢（上层目录常含
 * 好几个项目的 node_modules），命中率又极低，实测会让界面一直停在「正在找」。
 * 只在单个目录里 list + 前缀过滤，几十毫秒就能出结果。
 *
 * 这里只放纯逻辑与编排；真实 IO 由调用方注入（浏览器侧见 `locateIo.ts`），
 * 这样 node 能直接单测，不会被 `window.location` 之类拖累。
 */

export type LocateHit = {
  /** 绝对路径：点开时交给 openFile，它自己决定用哪个 root */
  abs: string
  /** 文件所在的作用域根 */
  root: string
  /** 相对 root 的路径 */
  path: string
  how: 'exact' | 'basename' | 'similar'
}

export type DirEntry = { path: string; type: 'file' | 'directory' }
export type FindItem = DirEntry

/** 定位用到的三个接口（`root` + 相对路径 / 名字）。 */
export type LocateIo = {
  stat: (root: string, path: string, signal?: AbortSignal) => Promise<unknown>
  find: (root: string, name: string, signal?: AbortSignal) => Promise<FindItem[]>
  list: (root: string, dir: string, signal?: AbortSignal) => Promise<DirEntry[]>
}

/** 作用域上限：再多也只是徒增 stat 次数，用户也不会往下看。 */
const MAX_SCOPE_ROOTS = 12
/** 往上级找几层：再往上通常整个盘都成了范围，扫起来没意义。 */
export const MAX_PARENT_LEVELS = 2
/** 结果上限：够用就行，排前面的才是大概率想要的。 */
const MAX_HITS = 8
/**
 * 总预算：跨项目 `find` 最坏要扫十几万条目，用户等 5 秒以上就会以为界面卡死。
 * 但它是软预算：只在两次搜索之间检查一次，单个请求仍受自身 30 秒超时约束
 * （`findLocal`），所以最坏情况要等那一个请求返回。
 */
const TOTAL_BUDGET_MS = 8000
/** 第 3 级最多试几个作用域：只扫当前 + 上级，别为「相似名」把每个项目都翻一遍。 */
const SIMILAR_SCOPE_LIMIT = 1 + MAX_PARENT_LEVELS

function trimEnd(path: string): string {
  return String(path ?? '').replace(/[\\/]+$/, '')
}

/** 绝对路径判定：盘符（`C:\`）或 UNC（`\\host\share`）。 */
export function isAbsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/** 上一级目录；盘符根（`C:\`）返回 null —— 不能把整块盘当搜索范围。 */
export function parentOf(dir: string): string | null {
  const d = trimEnd(dir)
  if (!d) return null
  const cut = Math.max(d.lastIndexOf('\\'), d.lastIndexOf('/'))
  // cut <= 1：只剩 `C:` / `/`，没有可退的层级
  if (cut <= 1) return null
  const head = d.slice(0, cut)
  if (/^[a-zA-Z]:$/.test(head)) return null
  return head
}

/**
 * 搜索作用域：当前工作区 → 上级目录（最多 `parents` 层）→ 其它已记录项目。
 *
 * 去重按 [`normKey`]（大小写不敏感、正反斜杠归一），`F:\a` 与 `f:/a/`
 * 不会被当成两个作用域各扫一遍。
 */
export function scopeRoots(
  root: string,
  projects: readonly string[] = [],
  parents = MAX_PARENT_LEVELS,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string | null | undefined) => {
    const trimmed = trimEnd(String(raw ?? '').trim())
    if (!trimmed) return
    const key = normKey(trimmed)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(trimmed)
  }

  push(root)
  let cursor = trimEnd(root)
  for (let level = 0; level < parents; level += 1) {
    const up = parentOf(cursor)
    if (!up) break
    push(up)
    cursor = up
  }
  for (const item of projects) push(item)

  return out.slice(0, MAX_SCOPE_ROOTS)
}

/** 相对路径归一：去前导分隔符、统一反斜杠。 */
export function normalizeRel(rel: string): string {
  return String(rel ?? '')
    .trim()
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]+/g, '\\')
}

/** 把相对路径拼成绝对路径（Windows 风格，可直接当 openFile 的入参）。 */
export function joinRoot(root: string, rel: string): string {
  const dir = trimEnd(root)
  const tail = normalizeRel(rel)
  if (!tail) return dir
  return dir ? `${dir}\\${tail}` : tail
}

/** 取最后一段（文件名 / 末级目录名）。 */
export function baseNameOf(path: string): string {
  const trimmed = trimEnd(path)
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed
}

/** 取目录部分（`a\b\c.mjs` → `a\b`；没有目录时返回空串）。 */
export function dirNameOf(rel: string): string {
  const trimmed = trimEnd(normalizeRel(rel))
  const cut = trimmed.lastIndexOf('\\')
  return cut > 0 ? trimmed.slice(0, cut) : ''
}

/**
 * 相似名匹配键：把文件名拆成「前缀 + 序号 + 扩展名」，扩展名必须一致。
 *
 * `patch-verify-4.mjs` → `patch-verify|.mjs`，于是 `patch-verify-12.mjs`
 * 算同族，而 `patch-verify-9.log` 不算（扩展名不同，多半是无关产物）。
 * 文件名里没有数字时返回 null（那就只认完全同名，不做相似）。
 */
export function similarKey(name: string): string | null {
  const match = /^(.*?)(\d+)(\.[^.]*)?$/.exec(name)
  if (!match) return null
  const prefix = match[1]
  // 只给了序号、没有可辨认的前缀（`4.mjs`）时，相似没有意义
  if (prefix.replace(/[^A-Za-z0-9]/g, '').length < 3) return null
  return `${prefix.toLowerCase()}|${(match[3] ?? '').toLowerCase()}`
}

/**
 * 在多个作用域里找这个文件，返回可点击的结果（最多 8 条）。
 *
 * 绝对路径只查它自己；相对路径按 exact → basename → similar 三级递进，
 * 哪一级先出结果就返回，不再往下烧查询。
 */
export async function locateFile(
  input: string,
  opts: { root: string; projects?: readonly string[]; signal?: AbortSignal },
  io: LocateIo,
): Promise<LocateHit[]> {
  const raw = String(input ?? '').trim()
  if (!raw) return []
  const signal = opts.signal
  const started = Date.now()
  const timedOut = (): boolean => Date.now() - started > TOTAL_BUDGET_MS

  const hits: LocateHit[] = []
  const seen = new Set<string>()
  const add = (root: string, rel: string, how: LocateHit['how']): void => {
    if (hits.length >= MAX_HITS) return
    const abs = joinRoot(root, rel)
    const key = normKey(abs)
    if (!key || seen.has(key)) return
    seen.add(key)
    hits.push({ abs, root, path: rel, how })
  }

  // 绝对路径：只有它自己一个作用域，别去别处按同名乱找
  if (isAbsPath(raw)) {
    const dir = raw.slice(0, Math.max(raw.lastIndexOf('\\'), raw.lastIndexOf('/')))
    const name = baseNameOf(raw)
    if (dir && name) {
      try {
        await io.stat(dir, name, signal)
        add(dir, name, 'exact')
      } catch {
        // 不存在就是空结果：绝对路径没有别的解释
      }
    }
    return hits
  }

  const rel = normalizeRel(raw)
  if (!rel) return []
  const roots = scopeRoots(opts.root, opts.projects ?? [])

  // 1. 精确相对路径：各作用域直接拼
  for (const root of roots) {
    if (signal?.aborted) return hits
    try {
      await io.stat(root, rel, signal)
      add(root, rel, 'exact')
    } catch {
      // 这个作用域下没有，继续
    }
    // 命中就停：别把其余作用域再 stat 一遍（用户看到的就是这一条）
    if (hits.length > 0 || timedOut()) return hits
  }

  // 2. 按文件名：`find` 只认完整 basename，浅层优先
  const name = baseNameOf(raw)
  if (name) {
    for (const root of roots) {
      if (signal?.aborted) return hits
      try {
        for (const item of await io.find(root, name, signal)) {
          if (item.type === 'directory') continue
          add(root, item.path, 'basename')
          if (hits.length >= MAX_HITS) return hits
        }
      } catch {
        // 单个作用域扫不动不影响其它
      }
      if (timedOut()) return hits
    }
  }
  if (hits.length > 0) return hits

  // 3. 原目录里的相似名：只 list 一个目录，很便宜，也最可能帮到人
  const dir = dirNameOf(rel)
  const key = similarKey(name)
  if (key) {
    for (const root of roots.slice(0, SIMILAR_SCOPE_LIMIT)) {
      if (signal?.aborted) return hits
      try {
        for (const item of await io.list(root, dir, signal)) {
          if (item.type === 'directory') continue
          const stem = similarKey(baseNameOf(item.path))
          if (stem !== key) continue
          add(root, item.path, 'similar')
          if (hits.length >= MAX_HITS) return hits
        }
      } catch {
        // 目录不存在（这个作用域下没有 .tmp 之类）就跳过
      }
      if (hits.length >= MAX_HITS || timedOut()) return hits
    }
  }

  return hits
}
