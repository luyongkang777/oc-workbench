/**
 * 启动阶段的项目清单规则。
 *
 * 这条规则是为了修「每次关掉再打开工作台，清单只剩第一个文件夹」：
 *
 * 启动时外壳先回 `oc:auth`，紧接着下发 `root:<上次的目录>`，而 `oc:projects`
 * 的清单回复往往晚几毫秒到几十毫秒。`root:` 一到就会调 `applyRoot`，
 * 那时内存里的清单还是空的 —— 如果照常落盘，projects.json 就被写成
 * 「只有当前这一个目录」，磁盘上的其它项目全被删掉。
 *
 * 两层保护：
 * 1. 写盘闸门（`createPersistGate`）：清单读回来之前一律不落盘。
 * 2. 基线补齐（`restoreMissingProjects`）：写盘前把「磁盘上原本有、这次却缺了」
 *    的项目补回来 —— 竞态是概率性的，闸门只能降低概率，这一层才保证不丢。
 */

import { normKey, parseProjects, projectNameOf, type Project } from './projectList.ts'

/**
 * 合并启动时的三份来源：
 * - `loaded`：外壳/服务端读回来的清单（带每个项目记住的界面状态，优先级最高）
 * - `inMemory`：清单回来之前，页面已经在操作的清单（可能只含刚打开的那个目录）
 * - `current`：当前根目录；不在任何一份里就补一条
 */
export function mergeStartupProjects(
  loaded: Project[],
  inMemory: Project[],
  current: string,
): Project[] {
  // loaded 在前：同一个路径只留先出现的那条，磁盘上的 state/file 不会被空项目覆盖。
  const list = parseProjects([...loaded, ...inMemory])
  const path = String(current ?? '').trim()
  if (!path) return list
  const has = list.some((p) => normKey(p.path) === normKey(path))
  if (has) return list
  return parseProjects([...list, { path, name: projectNameOf(path) }])
}

/**
 * 写盘前补齐：`baseline` 里有、`next` 里却没有的项目补回去。
 *
 * `baseline` 是「磁盘权威清单 + 运行中见过的项目」。只有用户显式删除时
 * 调用方才会把它从 baseline 里摘掉，所以这里补回来的一定是「不该丢的」。
 */
export function restoreMissingProjects(next: Project[], baseline: Project[]): Project[] {
  const keys = new Set(next.map((p) => normKey(p.path)))
  const missing = baseline.filter((p) => !keys.has(normKey(p.path)))
  if (missing.length === 0) return next
  return parseProjects([...next, ...missing])
}

/**
 * 写盘闸门：`hydrate` 之前的所有改动只留在内存。
 *
 * 只包一层布尔判断，是为了让「什么时候允许写盘」这件事可单测，
 * 不依赖 React。
 */
export function createPersistGate(persist: (list: Project[]) => void) {
  let hydrated = false
  return {
    /** 清单是否已经读回来（读回来之前不能写盘）。 */
    isHydrated: () => hydrated,
    /** 清单读回来时调一次：先就绪，再把合并结果落盘。 */
    hydrate(list: Project[]) {
      hydrated = true
      persist(list)
    },
    /** 普通改动：就绪后才落盘。 */
    save(list: Project[]) {
      if (hydrated) persist(list)
    },
  }
}
