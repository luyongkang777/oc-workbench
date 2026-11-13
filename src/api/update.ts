import { localRequest } from './client'

/** 更新检查结果：字段与外壳 `/local/update/check` 一一对应。 */
export type UpdateCheck = {
  /** 是否配置了更新源。false 时外壳不会发任何网络请求。 */
  configured: boolean
  /** 当前 exe 的版本（编译进外壳的）。 */
  current: string
  /** 清单地址本身，显示用。 */
  source: string | null
  latest: string | null
  newer: boolean
  notes: string
  /** 新包字节数；0 表示清单没给。 */
  size: number
  url: string | null
  /** 拉清单失败的原因（连不上、格式不对等）。 */
  error: string | null
}

/** 检查更新。未配置更新源时立刻返回，不产生任何外联。 */
export async function checkUpdate(): Promise<UpdateCheck> {
  return localRequest<UpdateCheck>('/local/update/check', undefined, 20_000)
}

/**
 * 下载并更新。
 *
 * 成功返回后外壳会在约 1 秒内退出，替换脚本接手：等进程退出 → 备份旧 exe →
 * 覆盖 → 启动新版本。所以成功后页面不用再做什么，等着被关掉即可。
 */
export async function applyUpdate(): Promise<{ ok: boolean; version: string }> {
  return localRequest<{ ok: boolean; version: string }>(
    '/local/update/apply',
    undefined,
    180_000,
    { method: 'POST' },
  )
}

/** 保存更新源（清单地址）；传空串表示清除。 */
export async function saveUpdateSource(url: string): Promise<void> {
  await localRequest('/local/update/source', undefined, 15_000, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })
}
