/**
 * 远程账号与仓库托管接口层（契约见 docs/remote-accounts-contract.md §3.1）。
 *
 * 与 git.ts 同一套写法：全部走 `localRequest`，错峰在 client.ts 统一处理
 * （token 头、超时、非 2xx 抛中文错误），这里只做 URL / body 拼装和字段解包。
 *
 * 为什么不能直连 GitHub / Gitea：
 * 1. Gitea 默认不开 CORS，浏览器 fetch 会被挡死；
 * 2. 外壳是 http://127.0.0.1:随机端口，部分站点拒非 https 的 Referer；
 * 3. token 不该进页面内存被 XSS 摸走。
 */
import { localRequest } from './client'

export type RemoteKind = 'github' | 'gitea'

export type RemoteAccount = {
  id: string
  kind: RemoteKind
  baseUrl: string
  webUrl: string
  username: string
  /** 读接口永远不回传 token，只给这个标记 */
  hasToken: boolean
  createdAt: number
}

export type RemoteRepo = {
  fullName: string
  name: string
  owner: string
  private: boolean
  cloneUrl: string
  sshUrl: string
  defaultBranch: string
  /** Unix 秒 */
  updatedAt: number
  /** 空仓库：首推不会冲突，界面上要标出来并排最前 */
  empty: boolean
}

/** probe 的返回：账号还没存，但已经验过 token 了 */
export type RemoteProbe = {
  kind: RemoteKind
  webUrl: string
  apiBase: string
  username: string
  /** 显示名（有就带上） */
  name?: string
}

export type SaveAccountInput = {
  /** 空串 = 让后端自动识别 */
  kind: RemoteKind | ''
  baseUrl: string
  token: string
  /** 空则由后端调一次 /user 填 */
  username?: string
  /** 空则由 kind + baseUrl 推导 */
  apiBase?: string
}

export type CreateRepoInput = {
  name: string
  private: boolean
  description?: string
}

/** 账号密码换来的令牌（契约 §7.1）：拿到就能直接当 saveAccount 的 token 用 */
export type LoginResult = {
  kind: RemoteKind
  baseUrl: string
  apiBase: string
  webUrl: string
  username: string
  name: string
  token: string
  tokenName: string
}

/** 账号读写只碰本地文件，10 秒足够 */
const ACCOUNT_TIMEOUT_MS = 10_000
/** probe / repos / create 要真连上游，给 25 秒（契约 §0） */
const NETWORK_TIMEOUT_MS = 25_000

function jsonInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/** 账号列表；没有账号返回空数组，不抛错。 */
export function listAccounts(signal?: AbortSignal): Promise<RemoteAccount[]> {
  return localRequest<{ accounts?: RemoteAccount[] }>(
    '/local/remote/accounts',
    signal,
    ACCOUNT_TIMEOUT_MS,
  ).then((res) => res.accounts ?? [])
}

/** 保存账号：同名（同 kind + apiBase + username）由后端更新而不是新增。 */
export function saveAccount(
  input: SaveAccountInput,
  signal?: AbortSignal,
): Promise<RemoteAccount> {
  return localRequest<{ account: RemoteAccount }>(
    '/local/remote/accounts',
    signal,
    ACCOUNT_TIMEOUT_MS,
    jsonInit(input),
  ).then((res) => res.account)
}

/** 删除账号；id 不存在时后端给 404「没有这个账号」。 */
export function deleteAccount(id: string, signal?: AbortSignal): Promise<void> {
  return localRequest<{ ok?: boolean }>(
    `/local/remote/accounts?id=${encodeURIComponent(id)}`,
    signal,
    ACCOUNT_TIMEOUT_MS,
    { method: 'DELETE' },
  ).then(() => undefined)
}

/**
 * 添加账号前先验一次 token。
 * `kind` 传空串时由后端自动识别（github.com → github，`/api/v1/version` 能通 → gitea）。
 */
export function probeHost(
  baseUrl: string,
  token: string,
  kind: RemoteKind | '' = '',
  signal?: AbortSignal,
): Promise<RemoteProbe> {
  return localRequest<RemoteProbe>(
    '/local/remote/probe',
    signal,
    NETWORK_TIMEOUT_MS,
    jsonInit({ baseUrl, token, kind }),
  )
}

/** 列该账号可见的仓库（自己的 + 协作的），`q` 由后端本地过滤。 */
export function listRemoteRepos(
  account: string,
  q = '',
  limit = 100,
  signal?: AbortSignal,
): Promise<RemoteRepo[]> {
  const query = `account=${encodeURIComponent(account)}&q=${encodeURIComponent(q)}&limit=${Math.trunc(limit)}`
  return localRequest<{ repos?: RemoteRepo[] }>(
    `/local/remote/repos?${query}`,
    signal,
    NETWORK_TIMEOUT_MS,
  ).then((res) => res.repos ?? [])
}

/** 建仓库：后端固定 auto_init=false，否则本地首推会被 non-fast-forward 拒掉。 */
export function createRemoteRepo(
  account: string,
  input: CreateRepoInput,
  signal?: AbortSignal,
): Promise<RemoteRepo> {
  return localRequest<{ repo: RemoteRepo }>(
    '/local/remote/create',
    signal,
    NETWORK_TIMEOUT_MS,
    jsonInit({ account, ...input }),
  ).then((res) => res.repo)
}

/**
 * 用 Gitea 账号密码换一个访问令牌（契约 §7.1）。
 *
 * 密码只在这一跳里出现：后端拿到就换令牌、换完即弃，不落盘也不回传。
 * GitHub 没有这条路径（2021 年就禁了密码认证），后端会直接 400。
 * `kind` 不传或传空时由后端按 §2 规则探测。
 */
export function loginWithPassword(input: {
  baseUrl: string
  username: string
  password: string
  kind?: RemoteKind
}): Promise<LoginResult> {
  return localRequest<LoginResult>(
    '/local/remote/login',
    undefined,
    NETWORK_TIMEOUT_MS,
    jsonInit({ ...input, tokenName: '' }),
  )
}

/** 让外壳用系统默认浏览器打开地址（GitHub 令牌页靠它，契约 §7.2）。 */
export function openExternalUrl(url: string): Promise<void> {
  return localRequest<{ ok?: boolean }>(
    '/local/remote/open-url',
    undefined,
    NETWORK_TIMEOUT_MS,
    jsonInit({ url }),
  ).then(() => undefined)
}
