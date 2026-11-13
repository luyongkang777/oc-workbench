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
  /** 用户主动跳过了这个版本（顶栏不再提示，点开面板仍可更新）。 */
  skipped: boolean
  /** 启动时是否自动检查（面板里的开关状态）。 */
  autoCheck: boolean
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

/** 页面启动时要的设置：要不要自动检查、更新源、跳过的是哪个版本。 */
export type UpdateConfig = {
  autoCheck: boolean
  source: string | null
  skipped: string | null
}

/**
 * 读更新设置。
 *
 * 单独一个轻量 GET：关掉自动检查时，页面不该为了「要不要检查」先做一次检查。
 */
export async function getUpdateConfig(): Promise<UpdateConfig> {
  return localRequest<UpdateConfig>('/local/update/config', undefined, 10_000)
}

/** 开/关启动时自动检查。 */
export async function setAutoCheck(enabled: boolean): Promise<void> {
  await localRequest('/local/update/auto', undefined, 15_000, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}

/** 跳过某个版本；传空串表示取消跳过。 */
export async function skipUpdate(version: string): Promise<void> {
  await localRequest('/local/update/skip', undefined, 15_000, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version }),
  })
}

/** 保存更新源（清单地址）；传空串表示清除。 */
export async function saveUpdateSource(url: string): Promise<void> {
  await localRequest('/local/update/source', undefined, 15_000, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })
}
