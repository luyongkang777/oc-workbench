import { localRequest } from './client'

/**
 * 本机 OpenCode CLI 的状态：`GET /local/cli/status`。
 *
 * 字段与外壳一一对应。`installed=false` 时 `newer=true` 表示「可以装」，
 * 而不是「有新版本」——界面文案要靠 `installed` 区分这两种情况。
 */
export type CliStatus = {
  /** 当前平台是否支持自动安装（只有 Windows）。 */
  supported: boolean
  installed: boolean
  /** 实际用的可执行文件（`.cmd` shim 也会给出来），没装为 null。 */
  path: string | null
  /** 本机版本，如 `2.2.5`；读了失败为 null。 */
  version: string | null
  /** 最新 v2 版本，如 `2.2.7`；查不到为 null。 */
  latest: string | null
  /** 需要装/需要升级。没装时也为 true（表示「可安装」）。 */
  newer: boolean
  /** 安装包字节数；0 表示发布列表没给。 */
  size: number
  notes: string
  url: string | null
  /** 启动时自动装/自动更新（面板里的开关状态）。 */
  autoUpdate: boolean
  /** 正在下载/安装。 */
  busy: boolean
  /** 当前阶段的人话描述（「下载 v2.2.7…」）。 */
  phase: string
  /** 已下载字节数 / 总字节数（0 表示未知）。 */
  done: number
  total: number
  error: string | null
}

/**
 * 读状态。
 *
 *   * `remote=true` 强制刷新「最新版本」缓存（默认 10 分钟）；
 *   * `latest=false` **完全不联网**，只报本机情况——顶栏挂载时用它，
 *     免得每次启动都去问 GitHub；点开面板时才带 `latest=true`。
 */
export async function getCliStatus(remote = false, latest = true): Promise<CliStatus> {
  const query: string[] = []
  if (remote) query.push('remote=1')
  if (!latest) query.push('latest=0')
  const suffix = query.length ? `?${query.join('&')}` : ''
  return localRequest<CliStatus>(`/local/cli/status${suffix}`, undefined, 30_000)
}

/**
 * 下载并安装/更新 CLI，阻塞到结束（下载 + 解压 + 替换约 1~5 分钟）。
 *
 * 安装过程中失败会带人话原因（网络、解压、文件被占用等），直接显示即可。
 */
export async function installCli(): Promise<{ ok: boolean; version: string }> {
  return localRequest<{ ok: boolean; version: string }>(
    '/local/cli/install',
    undefined,
    900_000,
    { method: 'POST' },
  )
}

/** 开/关启动时自动安装与自动更新。 */
export async function setCliAutoUpdate(enabled: boolean): Promise<void> {
  await localRequest('/local/cli/auto', undefined, 15_000, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}
