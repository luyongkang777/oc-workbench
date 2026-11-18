import { findLocal, listDirLocal, statFile } from '../api/localfs.ts'
import type { LocateIo } from './locateFile.ts'

/**
 * 定位用的真实 IO：三个 `local/fs` 接口。
 *
 * 单独放在这里而不是写进 `locateFile.ts`，是因为 `locateFile` 里的作用域计算
 * 是纯逻辑、要被 node 直接单测；一 import `localfs` 就会连带拉进 `client.ts`
 * （里面读了 `window.location`），node 跑不起来。
 */
export const localFsIo: LocateIo = {
  stat: (root, path, signal) => statFile(root, path, null, signal),
  find: (root, name, signal) => findLocal(root, name, signal),
  list: (root, dir, signal) => listDirLocal(root, dir, signal),
}
