/**
 * 查看区「打开的文件标签」的类型与命名规则。
 *
 * 从 App.tsx 抽出来的：这些是纯函数 / 纯类型，和组件状态无关，
 * 单独放一处便于以后写单测（目前由 tsc 覆盖）。
 */

/**
 * 查看区打开中的一个文件。
 *
 * `root` 是给「工作区外的文件」用的：它自己的目录当根，读写都落在那个目录下，
 * 但不会把整个工作区切走（会话/文件树还在原处）。
 */
export type FileTab = {
  key: string
  path: string
  root: string | null
  /** 每次打开/激活自增：同一个文件点两次也会重读 */
  seq: number
  /** 一次性跳转行号（1 基） */
  line: number | null
  /** 双击文件树：自增后目标编辑器打开完直接进编辑 */
  editSeq: number
}

/** 标签的稳定 key：外部文件把 root 也算进去，不同目录的同名文件不会互相顶掉。 */
export function fileTabKey(root: string | null, path: string): string {
  return root ? `${root}\u0000${path}` : path
}

/** 同时最多挂多少个编辑器：每个都带一份分页缓存，太多会白吃内存。 */
export const MAX_FILE_TABS = 12

/** 标签上只显示文件名（路径太长会把标签挤爆）。 */
export function tabName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/**
 * 打开新标签后做一次容量裁剪。
 *
 * 超过上限时从最左边淘汰「不是刚打开的、也不是当前激活的、并且没有未保存改动」的标签。
 * 返回 `dropped` 表示还有溢出但一个都不能删（都是脏的或者是当前）—— 调用方据此提示用户。
 */
export function trimTabs(
  tabs: FileTab[],
  keepKey: string,
  activeKey: string | null,
  dirty: Set<string>,
): { next: FileTab[]; dropped: boolean } {
  if (tabs.length <= MAX_FILE_TABS) return { next: tabs, dropped: false }

  const overflow = tabs.length - MAX_FILE_TABS
  const kept: FileTab[] = []
  let removed = 0
  for (const tab of tabs) {
    if (removed < overflow && tab.key !== keepKey && tab.key !== activeKey && !dirty.has(tab.key)) {
      removed += 1
      continue
    }
    kept.push(tab)
  }
  return { next: kept, dropped: removed < overflow }
}
