import type { Plugin } from 'vite'

/** dev 下的更新接口（模拟检查/下载进度，不替换 exe）。 */
export function localUpdatePlugin(): Plugin
