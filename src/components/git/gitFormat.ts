/**
 * git 面板的展示格式化：全是纯函数，`node --test` 直接 import 就能测。
 * 不放 React、不放请求，任何依赖都会让这个文件不可测。
 */
import type { GitChange, GitFile } from '../../api/git'
import type { RemoteAccount, RemoteRepo } from '../../api/remote'

/** 状态徽标颜色档位，样式侧按这些名字写 `git-tone-<tone>`。 */
export type StatusTone = 'add' | 'mod' | 'del' | 'new' | 'conflict'

const STATUS_LABELS: Record<GitChange, string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  untracked: '未跟踪',
  renamed: '重命名',
  conflicted: '冲突',
}

const STATUS_TONES: Record<GitChange, StatusTone> = {
  added: 'add',
  // 重命名本质是一次改名，用「修改」的颜色即可，不给它单独的档位
  modified: 'mod',
  renamed: 'mod',
  deleted: 'del',
  untracked: 'new',
  conflicted: 'conflict',
}

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** 超过这个天数就不再说「N 天前」，直接给日期 */
const MAX_DAYS = 30

/** 中文状态名。 */
export function statusLabel(s: GitChange): string {
  return STATUS_LABELS[s] ?? '改动'
}

/** 状态对应的颜色档位。 */
export function statusTone(s: GitChange): StatusTone {
  return STATUS_TONES[s] ?? 'mod'
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * Unix 秒 → 相对时间。
 *
 * 未来时间（时钟偏差）按「刚刚」处理，不出现「-3 分钟前」；
 * 非法值返回空串，调用方直接渲染成空白，不占位。
 */
export function relativeTime(unixSeconds: number, now: number = Date.now() / 1000): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return ''
  const diff = Math.max(0, Math.floor(now - unixSeconds))

  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`

  const days = Math.floor(diff / DAY)
  if (days <= MAX_DAYS) return `${days} 天前`

  const date = new Date(unixSeconds * 1000)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * 领先 / 落后说明。负数当 0（后端理论上不会给，但别让 UI 出现「领先 -1」）。
 * 同时领先又落后（分叉）时一并说出来。
 */
export function syncLabel(ahead: number, behind: number, noUpstream = false): string {
  if (noUpstream) return '还没关联远程分支'

  const a = Math.max(0, Math.trunc(ahead) || 0)
  const b = Math.max(0, Math.trunc(behind) || 0)

  if (a > 0 && b > 0) return `领先 ${a} 个提交，落后 ${b} 个提交`
  if (a > 0) return `领先 ${a} 个提交`
  if (b > 0) return `落后 ${b} 个提交`
  return '已同步'
}

/** 一句话概况，例如「3 个改动，其中 2 个未跟踪」。 */
export function summarizeChanges(files: GitFile[]): string {
  const total = files?.length ?? 0
  if (total === 0) return '没有改动'

  let untracked = 0
  for (const file of files) {
    if (file.status === 'untracked') untracked += 1
  }

  if (untracked === 0) return `${total} 个改动`
  if (untracked === total) return `${total} 个改动，全部未跟踪`
  return `${total} 个改动，其中 ${untracked} 个未跟踪`
}

/* ---------- 远程仓库选择 ---------- */

/**
 * 由项目根目录推一个默认仓库名。
 *
 * 取路径最后一段（Windows 反斜杠和 POSIX 斜杠都认），小写化，
 * 非法字符换成 `-`、连续 `-` 合并、去首尾 `-`；什么都不剩就给 `repo`。
 * 盘符根（`C:\`）没有目录名，也退回 `repo`。
 */
export function defaultRepoName(root: string): string {
  const raw = (root ?? '').trim()
  // 先去掉结尾分隔符：'a/b/' 的最后一段是 'b'，不是空串
  const trimmed = raw.replace(/[\\/]+$/, '')
  const segments = trimmed.split(/[\\/]/)
  const last = segments[segments.length - 1] ?? ''

  // 盘符根（C:\ / D:/）不是目录名，别把 'c' 当仓库名
  if (/^[a-zA-Z]:$/.test(last)) return 'repo'

  const name = last
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')

  return name || 'repo'
}

/** 主机名带端口：`https://github.com` → `github.com`，`http://192.168.31.8:3000` → `192.168.31.8:3000`。 */
function hostOf(baseUrl: string): string {
  const raw = (baseUrl ?? '').trim()
  if (!raw) return ''

  // 只在有协议时交给 URL；'localhost:3000' 会被 URL 当成 scheme，host 变空
  if (/^[a-zA-Z][\w+.-]*:\/\//.test(raw)) {
    try {
      return new URL(raw).host
    } catch {
      // 地址畸形：落到下面的手动切分
    }
  }

  const noScheme = raw.replace(/^[a-zA-Z][\w+.-]*:\/\//, '')
  return noScheme.split(/[/?#]/)[0] ?? ''
}

/**
 * 仓库列表排序：空仓库优先（首推不会冲突），同组内按最近更新时间倒序。
 *
 * 特意不原地排序；updatedAt 相同的保持传入顺序（用下标兜底，
 * 不依赖运行时 sort 稳定性，结果可复现）。
 */
export function sortRepos(repos: RemoteRepo[]): RemoteRepo[] {
  return (repos ?? [])
    .map((repo, index) => ({ repo, index }))
    .sort((a, b) => {
      if (a.repo.empty !== b.repo.empty) return a.repo.empty ? -1 : 1
      const diff = (b.repo.updatedAt || 0) - (a.repo.updatedAt || 0)
      if (diff !== 0) return diff
      return a.index - b.index
    })
    .map((item) => item.repo)
}

/**
 * 账号显示文案：`username @ host`（host 带端口）。
 * username 为空时只显示 host，至少别渲染成「 @ github.com」。
 */
export function accountLabel(a: RemoteAccount): string {
  const host = hostOf(a.baseUrl)
  const username = (a.username ?? '').trim()

  if (!username) return host || (a.baseUrl ?? '').trim()
  return host ? `${username} @ ${host}` : username
}

/**
 * 推送成功后的提示文案。
 *
 * `git push` 在「没有新提交可推」时也是退出码 0，只在输出里写
 * `Everything up-to-date`。这两种情况都得给用户一句明确的话，
 * 否则他会以为按钮没生效。
 */
export function describePushResult(output: string, branch: string): string {
  const text = (output ?? '').toLowerCase()
  // Gitea / GitHub / 本地裸库的措辞都落在这个正则里
  if (text.includes('everything up-to-date') || text.includes('everything up to date')) {
    return '远程已经是最新的，没有需要推送的提交'
  }
  const name = (branch ?? '').trim()
  return name ? `已推送到 ${name}` : '已推送到远程'
}
