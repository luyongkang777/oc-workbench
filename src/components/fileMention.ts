/**
 * `@` 文件提及的纯逻辑：从光标位置解析查询词、把选中的路径写回草稿。
 *
 * 只处理文本和光标，不碰 DOM 也不发请求（便于单测）。
 *
 * 判定口径（和主流编辑器的 @ 补全一致）：
 *   1. `@` 必须在行首或紧跟空白，`a@b.com` 这种邮箱不算；
 *   2. `@` 与光标之间不能有空白，有空白就说明这个提及已经结束；
 *   3. 光标后面若紧贴非空白字符，同样不算（用户是在句子中间打字）。
 */

/** @ 补全的一个候选项：路径 + 是文件还是目录。 */
export type MentionHit = {
  /** 相对项目根的路径（反斜杠分隔） */
  path: string
  type: 'file' | 'directory'
}

/** 一次提及的解析结果。 */
export type MentionQuery = {
  /** 用户已输入的部分（`@` 之后、光标之前），可能是空串。 */
  query: string
  /** `@` 在草稿里的下标。 */
  start: number
  /** 光标位置（= 提及文本的结束处）。 */
  end: number
}

/**
 * 找出光标前正在输入的 `@` 提及。
 *
 * 返回 `null` 表示当前不在提及状态（菜单应该收起）。
 */
export function parseMentionAt(text: string, caret: number): MentionQuery | null {
  if (caret < 0 || caret > text.length) return null

  // 从光标往前找最近的 `@`，中间遇到空白就放弃
  let at = -1
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = text[i]
    if (ch === '@') {
      at = i
      break
    }
    // 空白切断：说明光标前这一段不属于提及
    if (/\s/.test(ch)) return null
  }
  if (at < 0) return null

  // `@` 前面不能是「标识符字符」：那说明是邮箱/包名里的 @（a@b.com、@scope 除外）。
  // 中文/标点直接放行——实测用户习惯贴着中文打「看下@src/chat.ts」。
  if (at > 0) {
    const prev = text[at - 1]
    if (/[A-Za-z0-9_.+\-@]/.test(prev)) return null
  }

  // 光标后面若紧贴非空白字符，说明用户在句子中间，不该弹菜单
  const next = text[caret]
  if (next !== undefined && !/\s/.test(next)) return null

  return { query: text.slice(at + 1, caret), start: at, end: caret }
}

/** 提及插入后要不要补一个空格：后面已经是空白或行尾就不补。 */
function needsSpace(text: string, end: number): boolean {
  const next = text[end]
  return next === undefined ? true : !/\s/.test(next)
}

/**
 * 把选中的文件路径写回草稿，替换掉 `@query` 那一段。
 *
 * 返回新草稿和选完后的光标位置（调用方用它恢复焦点）。
 * 路径里的空格用反引号包起来，避免模型把 `Program Files` 当成两个词。
 *
 * `isDir` 为真时不补空格、改补反斜杠：用户选目录通常是想继续往下选文件
 * （后端也特意把目录一起返回）。补空格会把提及终结掉，等于逼他重打一遍 @。
 */
export function applyMention(
  text: string,
  mention: MentionQuery,
  filePath: string,
  isDir = false,
): { text: string; caret: number } {
  const before = text.slice(0, mention.start)
  const after = text.slice(mention.end)

  if (isDir && !/\s/.test(filePath)) {
    // 目录：`@src\components\`，光标留在末尾，提及继续有效。
    // 一律归一成反斜杠（和接口返回的形态一致），末尾只留一个分隔符。
    const clean = filePath.replace(/\//g, '\\').replace(/\\+$/, '')
    const inserted = `@${clean}\\`
    return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length }
  }

  const label = /\s/.test(filePath) ? `\`${filePath}\`` : filePath
  const tail = needsSpace(text, mention.end) ? ' ' : ''
  const inserted = `@${label}${tail}`
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length }
}

/**
 * 在一个较长的草稿里判断某个提及是否还完整（用于发送前提示未选中的 @）。
 *
 * 只是为了灰条提示，不做严格校验：返回所有「`@` 后紧跟非空白但后面没有路径分隔或扩展名」的片段，
 * 交给调用方决定要不要提醒。
 */
export function pendingMentions(text: string): string[] {
  const out: string[] = []
  const re = /(?:^|\s)@([^\s`]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const body = match[1]
    // 看起来像路径（含分隔符或扩展名）就当已经选好了
    if (/[\\/.]/.test(body)) continue
    out.push(body)
  }
  return out
}

/**
 * 菜单过滤：按路径子串匹配（大小写不敏感），越靠前的匹配排名越高。
 *
 * `query` 为空时原样返回，让菜单先展示「当前目录里最常见的几个」。
 */
export function filterMentions(paths: string[], query: string, limit = 30): string[] {
  // 正斜杠必须归一成反斜杠再比：后端返回的路径一律是反斜杠，
  // 而用户（尤其习惯 Unix 写法的人）会打 @src/components。
  // 后端已做同一步归一，前端漏做就会「打正斜杠零候选」（实测踩过）。
  const q = query.trim().toLowerCase().replace(/\//g, '\\')
  if (!q) return paths.slice(0, limit)

  const scored: { path: string; score: number }[] = []
  for (const path of paths) {
    const lower = path.toLowerCase()
    const at = lower.indexOf(q)
    if (at < 0) continue
    // 文件名命中优于目录名命中；越靠前越好；越短越好
    const base = lower.slice(Math.max(lower.lastIndexOf('\\'), lower.lastIndexOf('/')) + 1)
    const inBase = base.indexOf(q)
    const score = (inBase >= 0 ? 0 : 1000) + (inBase >= 0 ? inBase : at) + path.length / 1000
    scored.push({ path, score })
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, limit).map((item) => item.path)
}

/** 从候选里取出路径数组（给 filterMentions 用）。 */
export function mentionPaths(hits: MentionHit[]): string[] {
  return hits.map((hit) => hit.path)
}

/** 过滤候选并保持类型信息（菜单渲染用这个）。 */
export function filterHits(hits: MentionHit[], query: string, limit = 30): MentionHit[] {
  const wanted = new Set(filterMentions(mentionPaths(hits), query, limit))
  return hits.filter((hit) => wanted.has(hit.path))
}

/** 取路径最后一段，菜单里显示成主文本（完整路径放 title）。 */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut >= 0 ? path.slice(cut + 1) : path
}

/** 目录部分（用于菜单副标题），没有目录时返回空串。 */
export function dirName(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut > 0 ? path.slice(0, cut) : ''
}
