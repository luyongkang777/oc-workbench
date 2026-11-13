/**
 * 极简中文化 git 面板的接口层（契约见 docs/git-panel-contract.md）。
 *
 * 全部走 `localRequest`，与 `/local/fs/*` 共用 token / 超时 / 错误处理；
 * 后端已经把失败原因翻译成中文，这里不包装、不改写，直接让调用方展示。
 */
import { localRequest } from './client'

export type GitChange =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'untracked'
  | 'renamed'
  | 'conflicted'

export type GitFile = {
  /** 相对 root，反斜杠分隔 */
  path: string
  status: GitChange
  /** 是否已进暂存区 */
  staged: boolean
  /** 已暂存但同时工作区又有新改动 */
  worktreeDirty: boolean
  /** 仅重命名有 */
  renamedFrom?: string
}

export type GitCommit = {
  /** 完整 40 位 */
  hash: string
  /** 前 7 位 */
  short: string
  /** 父提交 hash，顺序保持 git 给的原样（第一个是主线父）；根提交是 [] */
  parents: string[]
  /** 第一行说明 */
  message: string
  author: string
  /** Unix 秒 */
  time: number
  isHead: boolean
  /** 纯标签名（去掉 `tag: ` 前缀） */
  tags: string[]
  /** `%D` 拆出来的原始装饰，例如 `HEAD -> main` / `origin/main`；没有装饰是 [] */
  refs: string[]
  /** 不在任何远程分支上（没有远程的仓库全是 true） */
  unpushed: boolean
}

/** `branches` 里的三种来源：本地分支 / 远程分支 / 标签。 */
export type GitBranchKind = 'local' | 'remote' | 'tag'

export type GitBranch = {
  /** 短名，`origin/main` 这种带远程前缀 */
  name: string
  kind: GitBranchKind
  /** 该引用指向的提交 */
  hash: string
}

/** `GET /local/git/log` 的完整响应；历史页签要一起拿分支和 HEAD 状态。 */
export type GitLog = {
  commits: GitCommit[]
  branches: GitBranch[]
  /** 当前分支名；detached 时是空串 */
  head: string
  detached: boolean
}

/** status 里的「上次提交」只保证这五个字段（没有 isHead / tags）。 */
export type GitLastCommit = Pick<GitCommit, 'hash' | 'short' | 'message' | 'author' | 'time'>

export type GitStatus = {
  initialized: boolean
  branch: string
  remote: string
  upstream: string
  ahead: number
  behind: number
  /** 没有 upstream 时后端会给 true */
  noUpstream?: boolean
  detached: boolean
  files: GitFile[]
  lastCommit: GitLastCommit | null
  gitignore: string[]
}

export type GitTreeEntry = {
  path: string
  name: string
  type: 'directory' | 'file'
  ignored: boolean
}

export type InitResult = { ok: boolean; branch: string; alreadyInitialized: boolean }
export type CommitResult = { ok: boolean; hash: string; short: string; count: number }
export type PushResult = { ok: boolean; branch: string; output: string }
export type RollbackResult = { ok: boolean; hash: string; mode: 'soft' | 'hard'; branch: string }
export type DiscardResult = { ok: boolean; count: number }
export type IgnoreResult = { ok: boolean; gitignore: string[] }
export type RemoteResult = { ok: boolean; remote: string }

/** status / log / tree / ignore / discard：默认 15 秒不够慢盘，契约给 30 秒 */
const STATUS_TIMEOUT_MS = 30_000
/** 首次初始化要写 .gitignore、建索引 */
const INIT_TIMEOUT_MS = 60_000
/** 提交要暂存全部改动，大仓库可能慢 */
const COMMIT_TIMEOUT_MS = 60_000
/** 推送要等网络和认证 */
const PUSH_TIMEOUT_MS = 180_000

function rootQuery(root: string): string {
  return `root=${encodeURIComponent(root)}`
}

/** POST 统一 JSON 体：后端读 1MB、按 content-type 解析。 */
function jsonInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/** 仓库状态。未初始化也返回 200（initialized:false），不抛错。 */
export function fetchGitStatus(root: string, signal?: AbortSignal): Promise<GitStatus> {
  return localRequest<GitStatus>(`/local/git/status?${rootQuery(root)}`, signal, STATUS_TIMEOUT_MS)
}

/** 一键初始化；已经是仓库时不报错，alreadyInitialized 为真。 */
export function initRepo(root: string, signal?: AbortSignal): Promise<InitResult> {
  return localRequest<InitResult>(
    `/local/git/init?${rootQuery(root)}`,
    signal,
    INIT_TIMEOUT_MS,
    jsonInit({}),
  )
}

/** 提交。paths 省略或空数组 = 暂存全部。 */
export function commitChanges(
  root: string,
  message: string,
  paths?: string[],
  signal?: AbortSignal,
): Promise<CommitResult> {
  return localRequest<CommitResult>(
    `/local/git/commit?${rootQuery(root)}`,
    signal,
    COMMIT_TIMEOUT_MS,
    jsonInit({ message, paths: paths && paths.length > 0 ? paths : undefined }),
  )
}

/** 推送。没有 upstream 时后端自动 `-u origin <branch>`。 */
export function pushRepo(
  root: string,
  setUpstream = true,
  signal?: AbortSignal,
): Promise<PushResult> {
  return localRequest<PushResult>(
    `/local/git/push?${rootQuery(root)}`,
    signal,
    PUSH_TIMEOUT_MS,
    jsonInit({ setUpstream }),
  )
}

/**
 * 提交历史（`git log --all`），默认 50 条。
 * 连同 branches / head / detached 一起返回，历史页签只发一次请求。
 * 空仓库返回 `{ commits: [], branches: [], head: '', detached: false }`。
 */
export function fetchLog(
  root: string,
  limit = 50,
  signal?: AbortSignal,
): Promise<GitLog> {
  return localRequest<GitLog>(
    `/local/git/log?${rootQuery(root)}&limit=${Math.trunc(limit)}`,
    signal,
    STATUS_TIMEOUT_MS,
  )
}

/** 回滚到某次提交：soft 保留改动到工作区，hard 连工作区一起丢。 */
export function rollbackTo(
  root: string,
  hash: string,
  mode: 'soft' | 'hard' = 'soft',
  signal?: AbortSignal,
): Promise<RollbackResult> {
  return localRequest<RollbackResult>(
    `/local/git/rollback?${rootQuery(root)}`,
    signal,
    STATUS_TIMEOUT_MS,
    jsonInit({ hash, mode }),
  )
}

/** 丢掉这些路径的本地改动（未跟踪的直接删掉）。 */
export function discardPaths(
  root: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<DiscardResult> {
  return localRequest<DiscardResult>(
    `/local/git/discard?${rootQuery(root)}`,
    signal,
    STATUS_TIMEOUT_MS,
    jsonInit({ paths }),
  )
}

/** 列一层目录（懒展开，不要一次拉全树）。path 省略 = 根目录。 */
export function fetchGitTree(
  root: string,
  path?: string,
  signal?: AbortSignal,
): Promise<GitTreeEntry[]> {
  const extra = path ? `&path=${encodeURIComponent(path)}` : ''
  return localRequest<{ entries?: GitTreeEntry[] }>(
    `/local/git/tree?${rootQuery(root)}${extra}`,
    signal,
    STATUS_TIMEOUT_MS,
  ).then((res) => res.entries ?? [])
}

/** 加/去排除规则；add 时后端还会把已跟踪的路径从索引里摘掉。 */
export function setIgnore(
  root: string,
  paths: string[],
  action: 'add' | 'remove' = 'add',
  signal?: AbortSignal,
): Promise<IgnoreResult> {
  return localRequest<IgnoreResult>(
    `/local/git/ignore?${rootQuery(root)}`,
    signal,
    STATUS_TIMEOUT_MS,
    jsonInit({ paths, action }),
  )
}

/** 设置远程地址；传空串 = 删掉 origin。 */
export function setRemote(root: string, url: string, signal?: AbortSignal): Promise<RemoteResult> {
  return localRequest<RemoteResult>(
    `/local/git/remote?${rootQuery(root)}`,
    signal,
    STATUS_TIMEOUT_MS,
    jsonInit({ url }),
  )
}
