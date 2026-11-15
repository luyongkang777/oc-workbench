import { findLocal, statFile } from '../api/localfs'

/**
 * 裸文件名定位：聊天里的工具详情常只写 `Status.h`，真实文件往往在 `src\Status.h`。
 *
 * 先看根目录有没有，没有再按名字在工作区里搜；返回命中路径与同名数量。
 * 抽成独立函数（而不是 hook 里的 useCallback）纯粹是为了让 useFileTabs 短一点。
 */
export async function resolveBareName(
  rootDir: string,
  name: string,
): Promise<{ path: string; total: number } | null> {
  try {
    await statFile(rootDir, name)
    return { path: name, total: 1 }
  } catch {
    // 根目录下没有，退回按文件名搜索
  }
  try {
    const matches = await findLocal(rootDir, name)
    const first = matches[0]
    return first ? { path: first.path, total: matches.length } : null
  } catch {
    return null
  }
}
