/**
 * 路由 agent 配置的读写（项目级 `.opencode/agents/`）。
 *
 * 为什么是项目级：opencode 会从当前目录向上发现 `.opencode/agents/*.md`，
 * 实测新增/删除文件后 `/api/agent` 立刻反映出来，不需要重启服务。
 * 路径在项目根内，可以直接复用 `/local/fs/*` 的 token 门禁与越界校验。
 */

import {
  createFileLocal,
  deleteLocal,
  listDirLocal,
  mkdirLocal,
  readText,
  statFile,
  writeText,
} from './localfs'
import type { RouterAgentFile } from '../components/routerConfig'

/** 相对项目根的 agent 目录。 */
export const ROUTER_DIR = '.opencode/agents'

export type RouterFileOnDisk = {
  name: string
  content: string
}

function relPath(name: string): string {
  return `${ROUTER_DIR}/${name}.md`
}

/** 目录不存在就建；已经存在时 mkdir 会报错，这里直接忽略。 */
async function ensureDir(root: string): Promise<void> {
  try {
    await mkdirLocal(root, '.opencode')
  } catch {
    // 已存在 / 并发建过，都正常
  }
  try {
    await mkdirLocal(root, ROUTER_DIR)
  } catch {
    // 同上
  }
}

async function exists(root: string, name: string): Promise<boolean> {
  try {
    const stat = await statFile(root, relPath(name))
    return !stat.binary
  } catch {
    return false
  }
}

/**
 * 读三个角色文件里实际存在的那些。
 *
 * 不假设目录一定在：先 list 一次，目录不存在直接返回空，
 * 避免每个文件都吃一个 404。
 */
export async function loadRouterFiles(
  root: string,
  names: string[],
): Promise<RouterFileOnDisk[]> {
  try {
    await listDirLocal(root, ROUTER_DIR)
  } catch {
    return []
  }
  const result: RouterFileOnDisk[] = []
  for (const name of names) {
    try {
      const content = await readText(root, relPath(name))
      result.push({ name, content })
    } catch {
      // 单个文件坏掉/被删，跳过即可，不影响另外两个
    }
  }
  return result
}

/**
 * 写三个文件。
 *
 * 失败时尽量回滚：已覆盖的恢复原内容，本次新建的删掉。
 * 写盘走「存在就 write、不存在先 create 再 write」——外壳的 write 只接受已存在文件。
 */
export async function saveRouterFiles(
  root: string,
  files: RouterAgentFile[],
): Promise<void> {
  await ensureDir(root)

  const backup: Array<{ name: string; content: string | null }> = []
  for (const file of files) {
    backup.push({
      name: file.name,
      content: (await exists(root, file.name)) ? await readText(root, relPath(file.name)) : null,
    })
  }

  const written: string[] = []
  try {
    for (const file of files) {
      const rel = relPath(file.name)
      const existed = backup.find((item) => item.name === file.name)?.content !== null
      if (!existed) await createFileLocal(root, rel)
      // 先登记再写：create 成功但 write 失败时也要回滚（删掉留下的空文件）；
      // 覆盖已有文件时同理，write 中途失败要恢复原内容。
      written.push(file.name)
      await writeText(root, rel, file.content, undefined, 'utf8')
    }
  } catch (error) {
    for (const name of written) {
      const original = backup.find((item) => item.name === name)
      try {
        if (original?.content === null) await deleteLocal(root, relPath(name))
        else if (original?.content !== undefined) {
          await writeText(root, relPath(name), original.content, undefined, 'utf8')
        }
      } catch {
        // 回滚失败也不能盖住原始错误
      }
    }
    throw error
  }
}

/**
 * 删掉三个角色文件；本来就不存在的不算错。
 *
 * 不删目录：外壳的 delete 对目录是 remove_dir_all，
 * 会把用户自己放在 `.opencode/agents/` 里的其它 agent 一起清掉。
 * 空目录留着不影响 opencode。
 */
export async function removeRouterFiles(root: string, names: string[]): Promise<void> {
  for (const name of names) {
    try {
      await deleteLocal(root, relPath(name))
    } catch {
      // 404 说明已经没了
    }
  }
}
