// Vite dev server 的本地 Git 中间件：接口与 Rust 外壳的 `/local/git/*` 对齐。
//
// 契约见 docs/git-panel-contract.md（唯一真相）；这里只做 dev 侧的 Node 实现，
// 生产走外壳，同一套 JSON 结构、同一套语义。
//
// 几条硬约束（踩过就知道）：
//   * 全程 execFile + 参数数组，永不拼 shell —— Windows 下路径带空格/中文时拼接必炸；
//   * 每个子进程都带 `-c core.quotepath=false`，且**放在子命令之前**，
//     否则中文文件名会变成 `\344\270\255` 八进制转义；
//   * 列表类输出统一 `-z`（NUL 分隔）解析，空格/引号/中文都不会把解析搞崩；
//   * 错误一律 `{ error, status }`，error 里带 git stderr 原文，不吞真实失败原因。
//
// 只在 `npm run dev` 生效，打包产物不包含它。

import { execFile, spawn } from 'node:child_process'
import { readFile, readdir, realpath, rm, stat as statFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { httpError, readBody, sendJson } from './dev-local-fs.mjs'

const execFileAsync = promisify(execFile)

/** 每次调用都要带的全局选项，必须在子命令之前。 */
const GIT_GLOBAL = ['-c', 'core.quotepath=false']
/** push 的输出可能很长（进度条 + 远端提示），给足缓冲。 */
const GIT_MAX_BUFFER = 10 * 1024 * 1024
/** 超时按契约分档：读 30s / 写 60s / 推送 180s。 */
const TIMEOUT_READ = 30_000
const TIMEOUT_WRITE = 60_000
const TIMEOUT_PUSH = 180_000
/** POST 请求体上限：契约写死 1MB。 */
const MAX_BODY_BYTES = 1024 * 1024
/** 错误信息里保留的 git 原文长度。 */
const MAX_DETAIL = 4000

/** 初始化时写的基础 .gitignore。 */
const BASE_GITIGNORE = [
  'node_modules/',
  'dist/',
  '.tmp/',
  '*.log',
  '.DS_Store',
  'target/',
  '.vite/',
]

/** tree 里不再往下展开的重目录（用户要排除整个目录，列到上一级就够）。 */
const HEAVY_DIRS = new Set(['node_modules', 'dist', 'target', '.vite'])

/** 冲突标记：porcelain v1 里这几种 XY 组合表示未合并。 */
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** 单个状态字母 → 契约枚举。C（copy）没有独立类型，按 renamed 归并。 */
const LETTER_STATUS = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'renamed',
  T: 'modified',
}

// ---------- 小工具 ----------

function clampInt(value, fallback, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(Math.max(Math.trunc(num), min), max)
}

/** git 的错误原文（优先 stderr，空则退 stdout），截断到可读长度。 */
export function withDetail(message, result) {
  const raw = `${result?.stderr ?? ''}`.trim() || `${result?.stdout ?? ''}`.trim()
  if (!raw) return message
  return `${message}：${raw.slice(0, MAX_DETAIL)}`
}

/** 路径只能落在 root 内：逐段校验，比「先 join 再 realpath」安全。 */
function splitRel(rel) {
  const parts = String(rel ?? '')
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.')
  for (const part of parts) {
    if (part === '..') throw httpError(400, '路径不允许包含 ..')
    if (part.includes(':')) throw httpError(400, '路径不允许包含盘符')
  }
  return parts
}

/**
 * 一条路径入参 → `{ rel, dirHint }`。
 * `rel` 一律用 `/`（git 的内部写法，也是 .gitignore 的语法要求），
 * `dirHint` 记住「调用方用结尾分隔符声明了这是目录」这件事 —— normalize 会把它抹掉。
 */
function normalizePathEntry(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  const dirHint = /[\\/]$/.test(text)
  const parts = splitRel(text)
  return { rel: parts.join('/'), dirHint }
}

/**
 * POST body 里的 `paths` → 干净的相对路径数组（`/` 分隔、去重、去空）。
 * 越界/盘符直接 400，别把 `..` 交给 git 去猜。
 */
export function normalizePaths(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const raw of input) {
    const { rel } = normalizePathEntry(raw)
    if (rel) out.push(rel)
  }
  return [...new Set(out)]
}

/** 目录地址：必须存在且是目录；不存在按契约给 400。 */
export async function resolveRoot(root) {
  if (!root) throw httpError(400, '缺少 root 参数')
  if (!path.isAbsolute(root)) throw httpError(400, 'root 必须是绝对路径')
  const real = await realpath(root).catch(() => {
    throw httpError(400, `目录不存在：${root}`)
  })
  const info = await statFile(real).catch(() => null)
  if (!info || !info.isDirectory()) throw httpError(400, `目录不存在：${root}`)
  return real
}

/** 两个绝对路径是不是同一个目录（Windows 大小写不敏感、分隔符不敏感）。 */
function samePath(left, right) {
  const norm = (value) => path.resolve(value).replace(/[\\/]+$/, '')
  const a = norm(left)
  const b = norm(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

// ---------- git 子进程 ----------

/**
 * 跑一条 git 命令，永不抛业务错误：退出码和输出原样返回。
 * 只有「git 根本没装」「超时」「输出爆缓冲」这几种基础设施故障直接抛。
 */
async function execGit(cwd, args, timeoutMs) {
  try {
    const { stdout, stderr } = await execFileAsync('git', [...GIT_GLOBAL, ...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
    })
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' }
  } catch (err) {
    if (err.code === 'ENOENT') throw httpError(400, '找不到 git 命令，请先安装 Git 并加入 PATH')
    if (err.killed) {
      throw httpError(504, `git 命令超时（${Math.round(timeoutMs / 1000)} 秒），操作已中断`)
    }
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw httpError(500, 'git 输出太大，已中断本次操作')
    }
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: `${err.stdout ?? ''}`,
      stderr: `${err.stderr ?? ''}`,
    }
  }
}

/** 同上，但要求退出码必须为 0，失败按给定状态码 + 中文前缀抛出（带原文）。 */
async function gitOk(cwd, args, timeoutMs, message, status = 400) {
  const result = await execGit(cwd, args, timeoutMs)
  if (result.code !== 0) throw httpError(status, withDetail(message, result))
  return result
}

/**
 * 需要往 stdin 灌数据的场景（`check-ignore --stdin`）。
 * execFile 没有 stdin 入口，这里用 spawn + 参数数组，同样不经 shell。
 * 返回 `{ code, stdout, stderr }`；code 为 -2 表示找不到 git，-1 表示超时/其它故障。
 */
function gitWithInput(cwd, args, input, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('git', [...GIT_GLOBAL, ...args], { cwd, windowsHide: true })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err?.message ?? err) })
      return
    }
    const out = []
    const errOut = []
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(payload)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({
        code: -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: `git 命令超时（${Math.round(timeoutMs / 1000)} 秒）`,
      })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => errOut.push(chunk))
    child.on('error', (err) => {
      finish({
        code: err.code === 'ENOENT' ? -2 : -1,
        stdout: '',
        stderr: String(err?.message ?? err),
      })
    })
    child.on('close', (code) => {
      finish({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errOut).toString('utf8'),
      })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

/** 仓库顶端；不是仓库（或 git 不可用）返回 null。 */
async function repoTopOf(cwd) {
  const result = await execGit(cwd, ['rev-parse', '--show-toplevel'], TIMEOUT_READ)
  if (result.code !== 0) return null
  const top = result.stdout.trim()
  return top ? path.resolve(top) : null
}

/**
 * 只认「root 自己就是仓库顶端」。
 * root 在别的仓库子目录里时不算已初始化 —— 否则 status 会返回父仓库的改动，
 * 路径也不是相对 root 的，整个面板就乱了。
 */
export async function isRepo(rootReal) {
  const top = await repoTopOf(rootReal)
  return !!top && samePath(top, rootReal)
}

/** 当前分支名；未出生分支（还没有提交）也能拿到；分离 HEAD 返回空串。 */
async function currentBranch(rootReal) {
  const result = await execGit(rootReal, ['symbolic-ref', '--short', '-q', 'HEAD'], TIMEOUT_READ)
  return result.code === 0 ? result.stdout.trim() : ''
}

/** 有 HEAD 才算有提交：空仓库不能拿 `git log` 去撞英文报错。 */
async function hasCommits(rootReal) {
  const result = await execGit(rootReal, ['rev-parse', '--verify', '--quiet', 'HEAD'], TIMEOUT_READ)
  return result.code === 0 && result.stdout.trim() !== ''
}

// ---------- 纯解析（不碰磁盘，单独测） ----------

/**
 * `## ` 分支头 → 分支/上游/领先落后/分离状态。
 * 实测格式：
 *   `## main` / `## main...origin/main` / `## main...origin/main [ahead 1, behind 2]`
 *   `## No commits yet on main` / `## HEAD (no branch)`
 */
export function parseBranchHeader(header) {
  const info = {
    branch: '',
    upstream: '',
    ahead: 0,
    behind: 0,
    detached: false,
    noUpstream: true,
  }
  if (typeof header !== 'string' || !header.startsWith('## ')) return info
  const body = header.slice(3).trim()
  if (body.startsWith('HEAD (no branch)')) {
    info.detached = true
    return info
  }
  if (body.startsWith('No commits yet on ')) {
    info.branch = body.slice('No commits yet on '.length).trim()
    return info
  }
  const flags = (/\[([^\]]*)\]/.exec(body)?.[1] ?? '').trim()
  const plain = body.replace(/\s*\[[^\]]*\]\s*$/, '').trim()
  const [left = '', right = ''] = plain.split('...')
  info.branch = left.trim()
  const upstream = right.trim()
  // [gone] 表示上游分支已删：当作没有上游，避免前端显示一个不存在的跟踪目标
  if (!upstream || flags === 'gone' || /\bgone\b/.test(flags)) {
    info.upstream = ''
    return info
  }
  info.upstream = upstream
  info.noUpstream = false
  const ahead = /\bahead (\d+)/.exec(flags)
  const behind = /\bbehind (\d+)/.exec(flags)
  info.ahead = ahead ? Number(ahead[1]) : 0
  info.behind = behind ? Number(behind[1]) : 0
  return info
}

/** 单条 porcelain 记录 → GitFile。 */
function porcelainFile(x, y, filePath, renamedFrom) {
  const conflicted = CONFLICT_CODES.has(`${x}${y}`)
  const untracked = x === '?' && y === '?'
  const staged = !untracked && x !== ' ' && x !== '?'
  // 契约 §2 status：X 非空且非 ? → staged；X 和 Y 同时非空且不是 ?? → worktreeDirty。
  // 冲突（UU/AA/...）也按同一条规则落在 worktreeDirty=true，不自作主张改语义。
  const worktreeDirty = !untracked && staged && y !== ' ' && y !== '?'
  const status = conflicted
    ? 'conflicted'
    : untracked
      ? 'untracked'
      : // index 状态优先：AM（新增后又在工作区改了）对用户仍然是「新增」
        (LETTER_STATUS[x] ?? LETTER_STATUS[y] ?? 'modified')
  const file = {
    path: filePath.split('/').join('\\'),
    status,
    staged: conflicted ? true : staged,
    worktreeDirty,
  }
  if (renamedFrom) file.renamedFrom = renamedFrom.split('/').join('\\')
  return file
}

/**
 * `git status --porcelain=v1 -z --branch` 的原始输出 → `{ header, files }`。
 * -z 下重命名/复制是「`XY 新路径\0旧路径`」两个 token（和普通模式的 `旧 -> 新` 顺序相反）。
 */
export function parsePorcelain(raw) {
  const tokens = String(raw ?? '').split('\0')
  const files = []
  let header = ''
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!token) continue
    if (!header && token.startsWith('## ')) {
      header = token
      continue
    }
    if (token.startsWith('!!')) continue // 没传 --ignored，正常不会出现
    if (token.length < 3) continue
    const x = token[0]
    const y = token[1]
    const filePath = token.slice(3)
    const renamed = x === 'R' || x === 'C' || y === 'R' || y === 'C'
    let renamedFrom = null
    if (renamed) {
      renamedFrom = tokens[i + 1] || null
      i += 1
    }
    files.push(porcelainFile(x, y, filePath, renamedFrom))
  }
  return { header, files }
}

/**
 * `%D` 装饰串 → `{ isHead, refs, tags }`。
 *
 * - `refs` 保留原始形态（`HEAD -> main`、`origin/main`、`tag: v0.2`），前端直接显示；
 * - 分离 HEAD 时 `%D` 只有一个 `HEAD`，它不是分支也不是标签，不放进 `refs`；
 * - `tags` 是 `refs` 里 `tag: xxx` 去掉前缀后的名字。
 */
export function parseDecor(raw) {
  let isHead = false
  const refs = []
  const tags = []
  for (const segment of String(raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    if (segment === 'HEAD' || segment.startsWith('HEAD ->')) isHead = true
    if (segment === 'HEAD') continue
    refs.push(segment)
    if (segment.startsWith('tag: ')) {
      const tag = segment.slice(5).trim()
      if (tag) tags.push(tag)
    }
  }
  return { isHead, refs, tags }
}

/** `git log --format=%H\0%h\0%s\0%an\0%at\0%D` 逐行输出 → GitCommit[]。 */
export function parseLogZ(raw) {
  const commits = []
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.trim()) continue
    const [hash = '', short = '', message = '', author = '', at = '', decor = ''] = line.split('\0')
    if (!hash) continue
    const { isHead, tags } = parseDecor(decor)
    commits.push({
      hash,
      short,
      message,
      author,
      time: Number(at) || 0,
      isHead,
      tags,
    })
  }
  return commits
}

/**
 * `git log --all --date-order --format=%H\0%h\0%P\0%s\0%an\0%at\0%D` 逐行输出 → 契约 §1 的提交数组。
 *
 * 只差 `unpushed`：它要一次 `rev-list` 的全量结果，由调用层统一补，避免 N+1。
 */
export function parseLogGraph(raw) {
  const commits = []
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.trim()) continue
    const [hash = '', short = '', parents = '', message = '', author = '', at = '', decor = ''] =
      line.split('\0')
    if (!hash) continue
    const { isHead, refs, tags } = parseDecor(decor)
    commits.push({
      hash,
      short,
      // %P 空格分隔；根提交是空串
      parents: parents.split(/\s+/).filter(Boolean),
      message,
      author,
      time: Number(at) || 0,
      isHead,
      tags,
      refs,
    })
  }
  return commits
}

/**
 * `git for-each-ref --format=%(refname:short)\0%(objectname)\0%(refname)` 输出 → 契约 §1 的 branches。
 *
 * `refs/remotes/origin/HEAD` 是符号引用（而且 `%(refname:short)` 只给 `origin`），必须按
 * 完整 refname 过滤掉，否则前端会多出一条假远程分支。
 */
export function parseBranches(raw) {
  const branches = []
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.trim()) continue
    const [name = '', hash = '', full = ''] = line.split('\0')
    if (!name || !full) continue
    let kind = ''
    if (full.startsWith('refs/heads/')) {
      kind = 'local'
    } else if (full.startsWith('refs/remotes/')) {
      if (full.endsWith('/HEAD')) continue
      kind = 'remote'
    } else if (full.startsWith('refs/tags/')) {
      kind = 'tag'
    } else {
      continue
    }
    branches.push({ name, kind, hash })
  }
  return branches
}

/**
 * 一条路径 → .gitignore 规则。
 * 注意分隔符必须转成 `/`：gitignore 里反斜杠是转义符，写 `src\a.ts` 会匹配不到任何东西。
 */
export function buildIgnoreRule(relPath, isDir) {
  const cleaned = String(relPath ?? '')
    .replace(/[\\/]+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  if (!cleaned) return ''
  return isDir ? `${cleaned}/` : cleaned
}

/** .gitignore 正文 → 有效行（丢掉空行和 # 注释，其余保留原样）。 */
export function parseGitignore(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
}

/** 远程地址形态校验：https/http、git@host:path、ssh://、git://、file://、本地路径。 */
export function isValidRemoteUrl(url) {
  const text = String(url ?? '').trim()
  if (!text || text.includes('\0') || /[\r\n]/.test(text)) return false
  // 本地路径优先判：盘符 / UNC / 以 / 开头 —— 这些里面带空格和中文都是合法的
  if (/^[A-Za-z]:[\\/]/.test(text)) return true
  if (text.startsWith('\\\\') || text.startsWith('/')) return true
  // 远端形态不允许空格
  if (/\s/.test(text)) return false
  if (/^https?:\/\/[^\s/]+/i.test(text)) return true
  if (/^git@[^\s:/]+:[^\s]+$/i.test(text)) return true
  if (/^ssh:\/\/[^\s]+$/i.test(text)) return true
  if (/^git:\/\/[^\s]+$/i.test(text)) return true
  if (/^file:\/\/[^\s]+$/i.test(text)) return true
  return false
}

// ---------- 接口实现 ----------

async function readGitignoreLines(rootReal) {
  const text = await readFile(path.join(rootReal, '.gitignore'), 'utf8').catch(() => null)
  return text === null ? [] : parseGitignore(text)
}

async function readLastCommit(rootReal) {
  const result = await execGit(
    rootReal,
    ['log', '-1', '--format=%H%x00%h%x00%s%x00%an%x00%at'],
    TIMEOUT_READ,
  )
  if (result.code !== 0) return null
  const line = result.stdout.trim()
  if (!line) return null
  const [hash = '', short = '', message = '', author = '', at = ''] = line.split('\0')
  if (!hash) return null
  return { hash, short, message, author, time: Number(at) || 0 }
}

/** GET /local/git/status */
export async function gitStatus({ root }) {
  const rootReal = await resolveRoot(root)
  if (!(await isRepo(rootReal))) {
    return {
      initialized: false,
      branch: '',
      remote: '',
      upstream: '',
      ahead: 0,
      behind: 0,
      detached: false,
      files: [],
      lastCommit: null,
      gitignore: [],
    }
  }

  const status = await execGit(
    rootReal,
    // -uall：默认 -unormal 会把未跟踪目录折叠成一条 `?? src/`，面板里点不开具体文件
    ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'],
    TIMEOUT_READ,
  )
  if (status.code !== 0) throw httpError(400, withDetail('读取仓库状态失败', status))

  const { header, files } = parsePorcelain(status.stdout)
  const branchInfo = parseBranchHeader(header)

  const remoteResult = await execGit(rootReal, ['config', '--get', 'remote.origin.url'], TIMEOUT_READ)
  const remote = remoteResult.code === 0 ? remoteResult.stdout.trim() : ''

  const lastCommit = await readLastCommit(rootReal)
  const gitignore = await readGitignoreLines(rootReal)

  const payload = {
    initialized: true,
    branch: branchInfo.branch,
    remote,
    upstream: branchInfo.upstream,
    ahead: branchInfo.ahead,
    behind: branchInfo.behind,
    detached: branchInfo.detached,
    files,
    lastCommit,
    gitignore,
  }
  if (branchInfo.noUpstream) payload.noUpstream = true
  return payload
}

/** POST /local/git/init */
export async function gitInit({ root }) {
  const rootReal = await resolveRoot(root)
  if (await isRepo(rootReal)) {
    return { ok: true, branch: (await currentBranch(rootReal)) || 'main', alreadyInitialized: true }
  }

  const withBranch = await execGit(rootReal, ['init', '-b', 'main'], TIMEOUT_WRITE)
  if (withBranch.code !== 0) {
    // git < 2.28 不认 -b：退回 init + 手动把 HEAD 指到 main
    await gitOk(rootReal, ['init'], TIMEOUT_WRITE, '初始化 Git 仓库失败')
    await gitOk(
      rootReal,
      ['symbolic-ref', 'HEAD', 'refs/heads/main'],
      TIMEOUT_WRITE,
      '设置默认分支失败',
    )
  }

  // 只在没有 .gitignore 时写：已有的规则是用户的，不覆盖
  const ignoreFile = path.join(rootReal, '.gitignore')
  const exists = await statFile(ignoreFile).then(
    () => true,
    () => false,
  )
  if (!exists) await writeFile(ignoreFile, `${BASE_GITIGNORE.join('\n')}\n`, 'utf8')

  return { ok: true, branch: 'main', alreadyInitialized: false }
}

/** POST /local/git/commit */
export async function gitCommit({ root, body }) {
  const rootReal = await resolveRoot(root)
  if (!(await isRepo(rootReal))) throw httpError(400, '这个目录还不是 Git 仓库，先初始化')

  const message = String(body?.message ?? '').trim()
  if (!message) throw httpError(400, '提交说明不能为空')
  const paths = normalizePaths(body?.paths)

  await gitOk(
    rootReal,
    paths.length ? ['add', '-A', '--', ...paths] : ['add', '-A'],
    TIMEOUT_WRITE,
    '暂存改动失败',
  )

  // 先看暂存区有没有东西，别让 git 用英文报「nothing to commit」
  const staged = await execGit(
    rootReal,
    paths.length ? ['diff', '--cached', '--quiet', '--', ...paths] : ['diff', '--cached', '--quiet'],
    TIMEOUT_WRITE,
  )
  if (staged.code === 0) throw httpError(409, '没有可提交的改动')
  if (staged.code !== 1) throw httpError(400, withDetail('检查暂存区失败', staged))

  const commit = await execGit(
    rootReal,
    paths.length ? ['commit', '-m', message, '--', ...paths] : ['commit', '-m', message],
    TIMEOUT_WRITE,
  )
  if (commit.code !== 0) {
    const detail = withDetail('提交失败', commit)
    // 身份没配是初次使用者最常见的坑，给一句直接的修法（git 原文照样保留）
    if (/user\.(name|email)|tell me who you are/i.test(detail)) {
      throw httpError(
        400,
        `${detail}\n请先配置 Git 用户：git config --global user.name "你的名字"，git config --global user.email "你的邮箱"`,
      )
    }
    throw httpError(400, detail)
  }

  const head = await gitOk(rootReal, ['rev-parse', 'HEAD'], TIMEOUT_WRITE, '提交后读取版本号失败')
  const hash = head.stdout.trim()
  const show = await execGit(rootReal, ['show', '--name-only', '--format=', 'HEAD'], TIMEOUT_WRITE)
  const count =
    show.code === 0
      ? show.stdout.split('\n').filter((line) => line.trim() !== '').length
      : 0

  return { ok: true, hash, short: hash.slice(0, 7), count }
}

/** POST /local/git/push */
export async function gitPush({ root, body }) {
  const rootReal = await resolveRoot(root)
  if (!(await isRepo(rootReal))) throw httpError(400, '这个目录还不是 Git 仓库，先初始化')
  const setUpstream = body?.setUpstream !== false

  const remote = await execGit(rootReal, ['remote', 'get-url', 'origin'], TIMEOUT_READ)
  if (remote.code !== 0) throw httpError(400, '还没设置远程仓库，先填一个地址')

  const branch = await currentBranch(rootReal)
  if (!branch) throw httpError(400, '当前不在任何分支上，无法推送')

  const upstream = await execGit(rootReal, ['rev-parse', '--abbrev-ref', '@{upstream}'], TIMEOUT_READ)
  const hasUpstream = upstream.code === 0 && upstream.stdout.trim() !== ''

  let args
  if (hasUpstream) {
    args = ['push']
  } else {
    args = setUpstream ? ['push', '-u', 'origin', branch] : ['push', 'origin', branch]
  }

  const result = await execGit(rootReal, args, TIMEOUT_PUSH)
  const combined = `${result.stdout}${result.stderr}`.trim()
  if (result.code !== 0) throw httpError(502, withDetail('推送失败', result))

  return { ok: true, branch, output: combined.slice(0, 4000) }
}

/** GET /local/git/log —— 契约 §1：提交 + 分支 + HEAD，供前端画图形树。 */
export async function gitLog({ root, limit }) {
  const rootReal = await resolveRoot(root)
  if (!(await isRepo(rootReal))) throw httpError(400, '这个目录还不是 Git 仓库，先初始化')
  const count = clampInt(limit, 50, 1, 200)
  // 还没有任何提交：先判掉，空仓库不该拿 git log 去撞报错
  if (!(await hasCommits(rootReal))) return emptyLog()

  // 一次拿全局部/远程/标签（N+1 是这里的头号禁忌）
  const refsResult = await execGit(
    rootReal,
    [
      'for-each-ref',
      '--format=%(refname:short)%00%(objectname)%00%(refname)',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ],
    TIMEOUT_READ,
  )
  const branches = refsResult.code === 0 ? parseBranches(refsResult.stdout) : []

  const branch = await currentBranch(rootReal)

  const result = await execGit(
    rootReal,
    [
      'log',
      '--all',
      '--date-order',
      '-n',
      String(count),
      '--format=%H%x00%h%x00%P%x00%s%x00%an%x00%at%x00%D',
    ],
    TIMEOUT_READ,
  )
  if (result.code !== 0) throw httpError(400, withDetail('读取提交历史失败', result))
  const commits = parseLogGraph(result.stdout)

  // 未推送：一次 rev-list 拿全量集合，绝不对每个提交单独调 git。
  // 没有远程引用时没法比，按契约「全部未推送」；rev-list 失败同样退化成全部未推送。
  let unpushedSet = null
  if (branches.some((entry) => entry.kind === 'remote')) {
    const rev = await execGit(rootReal, ['rev-list', '--all', '--not', '--remotes'], TIMEOUT_READ)
    if (rev.code === 0) {
      unpushedSet = new Set(
        rev.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      )
    }
  }
  for (const commit of commits) {
    commit.unpushed = unpushedSet === null ? true : unpushedSet.has(commit.hash)
  }

  return { commits, branches, head: branch, detached: branch === '' }
}

/** 空仓库 / 还没有提交时的固定结构（契约 §1 最后一条）。 */
function emptyLog() {
  return { commits: [], branches: [], head: '', detached: false }
}

/** POST /local/git/rollback */
export async function gitRollback({ root, body }) {
  const rootReal = await resolveRoot(root)
  if (!(await isRepo(rootReal))) throw httpError(400, '这个目录还不是 Git 仓库，先初始化')

  const hash = String(body?.hash ?? '').trim()
  if (!hash) throw httpError(400, '缺少要回滚的提交')
  const rawMode = body?.mode === undefined || body?.mode === null ? 'soft' : String(body.mode)
  const mode = rawMode.trim() || 'soft'
  if (mode !== 'soft' && mode !== 'hard') throw httpError(400, '不认识的回滚方式')
  // 以 - 开头的会被 git 当成选项；空白/NUL 直接拒掉
  if (hash.startsWith('-') || /[\s\0]/.test(hash)) throw httpError(400, '提交标识看起来不对')

  const verify = await execGit(
    rootReal,
    ['rev-parse', '--verify', '--quiet', `${hash}^{commit}`],
    TIMEOUT_READ,
  )
  const resolved = verify.code === 0 ? verify.stdout.trim() : ''
  if (!resolved) throw httpError(400, '找不到这个提交')

  await gitOk(rootReal, ['reset', `--${mode}`, resolved], TIMEOUT_WRITE, '回滚失败')

  return { ok: true, hash, mode, branch: await currentBranch(rootReal) }
}

/** POST /local/git/discard —— 只丢本地改动，历史里不出现 */
export async function gitDiscard({ root, body }) {
  const rootReal = await resolveRoot(root)
  if (!(await isRepo(rootReal))) throw httpError(400, '这个目录还不是 Git 仓库，先初始化')

  const paths = normalizePaths(body?.paths)
  if (!paths.length) throw httpError(400, '缺少要撤销的路径')

  let count = 0
  for (const rel of paths) {
    const restore = await execGit(
      rootReal,
      ['restore', '--source=HEAD', '--staged', '--worktree', '--', rel],
      TIMEOUT_READ,
    )
    if (restore.code === 0) {
      count += 1
      continue
    }

    // git restore 失败基本只有两种情况：路径没被跟踪，或者真出错了
    const tracked = await execGit(rootReal, ['ls-files', '--error-unmatch', '--', rel], TIMEOUT_READ)
    if (tracked.code === 0) throw httpError(400, withDetail(`撤销「${rel}」失败`, restore))

    // 未跟踪：文件删文件、目录删目录
    const abs = path.join(rootReal, ...rel.split('/'))
    const inside = path.relative(rootReal, abs)
    if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
      throw httpError(400, `路径越界：${rel}`)
    }
    await rm(abs, { recursive: true, force: true })
    count += 1
  }

  return { ok: true, count }
}

/** 这些路径里哪些被忽略。未初始化 / 无匹配一律空集合。 */
async function ignoredPaths(rootReal, entries) {
  const ignored = new Set()
  if (!entries.length) return ignored
  if (!(await isRepo(rootReal))) return ignored

  const input = `${entries.map((entry) => entry.path.replace(/\\/g, '/')).join('\0')}\0`
  // 不带 --no-index：和 Rust 外壳一致。已跟踪的路径不会被判成「已忽略」——
  // 这更贴近事实（.gitignore 管不住已经进索引的文件），也让 dev/生产行为一致。
  const result = await gitWithInput(
    rootReal,
    ['check-ignore', '--stdin', '-z'],
    input,
    TIMEOUT_READ,
  )
  // 退出码 1 = 一条都没匹配，不是错误
  if (result.code !== 0 && result.code !== 1) {
    if (result.code === -2) throw httpError(400, '找不到 git 命令，请先安装 Git 并加入 PATH')
    return ignored
  }
  for (const token of result.stdout.split('\0')) {
    if (token) ignored.add(token.split('/').join('\\'))
  }
  return ignored
}

/** GET /local/git/tree */
export async function gitTree({ root, relPath = '' }) {
  const rootReal = await resolveRoot(root)
  const parts = splitRel(relPath)
  const name = parts[parts.length - 1] ?? ''

  // .git 和重目录都不展开：列到上一级就够，用户要排除的是整个目录
  if (name === '.git' || HEAVY_DIRS.has(name)) return { entries: [] }

  const dirAbs = path.join(rootReal, ...parts)
  const info = await statFile(dirAbs).catch(() => null)
  if (!info || !info.isDirectory()) throw httpError(400, `目录不存在：${relPath || '.'}`)

  const dirents = await readdir(dirAbs, { withFileTypes: true }).catch(() => [])
  const baseRel = parts.join('\\')
  const entries = []
  for (const dirent of dirents) {
    if (dirent.name === '.git') continue
    const isDir = dirent.isDirectory()
    entries.push({
      path: baseRel ? `${baseRel}\\${dirent.name}` : dirent.name,
      name: dirent.name,
      type: isDir ? 'directory' : 'file',
      ignored: false,
    })
  }

  const ignored = await ignoredPaths(rootReal, entries)
  for (const entry of entries) entry.ignored = ignored.has(entry.path)

  // 与 /local/fs/list 一致：目录在前，再按名字（大小写不敏感）
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    const left = a.name.toLowerCase()
    const right = b.name.toLowerCase()
    return left < right ? -1 : left > right ? 1 : 0
  })

  return { entries }
}

async function isDirectoryOnDisk(rootReal, rel) {
  const abs = path.join(rootReal, ...rel.split('/'))
  const info = await statFile(abs).catch(() => null)
  return !!info && info.isDirectory()
}

/** POST /local/git/ignore */
export async function gitIgnore({ root, body }) {
  const rootReal = await resolveRoot(root)
  if (!(await isRepo(rootReal))) throw httpError(400, '这个目录还不是 Git 仓库，先初始化')

  const action = body?.action === 'remove' ? 'remove' : 'add'
  const rawPaths = Array.isArray(body?.paths) ? body.paths : []
  const wanted = rawPaths
    .map((raw) => normalizePathEntry(raw))
    .filter((entry) => entry.rel)
  if (!wanted.length) throw httpError(400, '缺少要排除的路径')

  const ignoreFile = path.join(rootReal, '.gitignore')
  const existingText = await readFile(ignoreFile, 'utf8').catch(() => '')
  const existing = parseGitignore(existingText)

  if (action === 'add') {
    const known = new Set(existing)
    const added = []
    for (const { rel, dirHint } of wanted) {
      const isDir = dirHint || (await isDirectoryOnDisk(rootReal, rel))
      const rule = buildIgnoreRule(rel, isDir)
      if (!rule) continue
      // 同一个目标可能已经写成 `dir` 或 `dir/`，两种都算已存在
      const plainRule = rule.replace(/\/$/, '')
      if (known.has(rule) || known.has(plainRule) || known.has(`${plainRule}/`)) continue
      known.add(rule)
      added.push(rule)

      // 关键：已被 git 跟踪的路径必须先摘出索引，否则光写 .gitignore 不生效
      const tracked = await execGit(rootReal, ['ls-files', '--error-unmatch', '--', rel], TIMEOUT_READ)
      if (tracked.code === 0) {
        await gitOk(
          rootReal,
          ['rm', '-r', '--cached', '--', rel],
          TIMEOUT_READ,
          `把「${rel}」从索引里移除失败`,
        )
      }
    }
    if (added.length) {
      const separator = existingText && !existingText.endsWith('\n') ? '\n' : ''
      await writeFile(ignoreFile, `${existingText}${separator}${added.join('\n')}\n`, 'utf8')
    }
    return { ok: true, gitignore: await readGitignoreLines(rootReal) }
  }

  // remove：精确匹配 `path` 与 `path/` 两种写法
  const drop = new Set()
  for (const { rel } of wanted) {
    const plain = buildIgnoreRule(rel, false)
    if (!plain) continue
    drop.add(plain)
    drop.add(`${plain}/`)
  }
  const kept = existing.filter((line) => !drop.has(line))
  if (kept.length !== existing.length) {
    await writeFile(ignoreFile, kept.length ? `${kept.join('\n')}\n` : '', 'utf8')
  }
  return { ok: true, gitignore: await readGitignoreLines(rootReal) }
}

/** POST /local/git/remote */
export async function gitRemote({ root, body }) {
  const rootReal = await resolveRoot(root)
  if (!(await isRepo(rootReal))) throw httpError(400, '这个目录还不是 Git 仓库，先初始化')

  const url = String(body?.url ?? '').trim()
  if (!url) {
    // 空地址 = 解除远程；本来就没有 origin 就当成功
    await execGit(rootReal, ['remote', 'remove', 'origin'], TIMEOUT_READ)
    return { ok: true, remote: '' }
  }
  if (!isValidRemoteUrl(url)) throw httpError(400, '远程地址看起来不对')

  const added = await execGit(rootReal, ['remote', 'add', 'origin', url], TIMEOUT_READ)
  if (added.code !== 0) {
    await gitOk(rootReal, ['remote', 'set-url', 'origin', url], TIMEOUT_READ, '设置远程地址失败')
  }
  return { ok: true, remote: url }
}

// ---------- 路由 ----------

/** 接口表：action → { method, run }，顺序即文档顺序。 */
const ROUTES = {
  status: { method: 'GET', run: gitStatus },
  init: { method: 'POST', run: gitInit },
  commit: { method: 'POST', run: gitCommit },
  push: { method: 'POST', run: gitPush },
  log: { method: 'GET', run: gitLog },
  rollback: { method: 'POST', run: gitRollback },
  discard: { method: 'POST', run: gitDiscard },
  tree: { method: 'GET', run: gitTree },
  ignore: { method: 'POST', run: gitIgnore },
  remote: { method: 'POST', run: gitRemote },
}

/**
 * 内部入口：不起 HTTP，直接按 action 调实现（测试与中间件共用同一条路）。
 * 返回值就是直接写进响应的 JSON 对象；失败抛 `{ status, message }`。
 */
export async function gitApi({ method = 'GET', action, root = '', relPath = '', limit, body = null }) {
  const route = Object.prototype.hasOwnProperty.call(ROUTES, action) ? ROUTES[action] : null
  if (!route) throw httpError(404, '未知的本地 Git 接口')
  const isHead = method === 'HEAD' && route.method === 'GET'
  if (method !== route.method && !isHead) {
    throw httpError(405, route.method === 'POST' ? '这个接口只支持 POST' : '这个接口只支持 GET')
  }
  return route.run({ root, relPath, limit, body: body ?? {} })
}

/** POST 的 JSON body；GET 返回 null。 */
async function readJsonBody(req) {
  if ((req.method || 'GET') !== 'POST') return null
  let raw
  try {
    raw = await readBody(req, MAX_BODY_BYTES)
  } catch (err) {
    // readBody 的 413 文案是给保存文件用的（写着 8MB），这里按 Git 的实际上限改写
    if (err.status === 413) throw httpError(413, '请求体太大（上限 1MB）')
    throw err
  }
  if (!raw.length) return {}
  try {
    const parsed = JSON.parse(raw.toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw httpError(400, '请求体不是合法的 JSON')
  }
}

async function handle(req, res) {
  const method = req.method || 'GET'
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    throw httpError(405, '只支持 GET / POST')
  }
  const url = new URL(req.url, 'http://127.0.0.1')
  const action = url.pathname.replace(/^\/local\/git\/?/, '')
  const body = await readJsonBody(req)
  const result = await gitApi({
    method,
    action,
    root: url.searchParams.get('root') || '',
    relPath: url.searchParams.get('path') || '',
    limit: url.searchParams.get('limit') ?? undefined,
    body,
  })
  sendJson(res, 200, result)
}

/**
 * 只拦 `/local/git` 前缀，其余请求原样交给 Vite。
 *
 * 注意挂载顺序：`localFsPlugin` 拦的是所有 `/local/*`，所以 vite.config.ts 里
 * 必须写成 `[react(), localGitPlugin(), localFsPlugin()]`，否则
 * `/local/git/status` 会先被 fs 插件接走，报「未知的本地文件接口」。
 */
export function localGitPlugin() {
  return {
    name: 'oc-workbench-local-git',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || ''
        if (url !== '/local/git' && !url.startsWith('/local/git/')) {
          next()
          return
        }
        handle(req, res).catch((err) => {
          const status = err.status || 500
          const message = err.status
            ? err.message
            : `本地 Git 操作失败（${err.code || err.message || 'unknown'}）`
          sendJson(res, status, { error: message, status })
        })
      })
    },
  }
}
