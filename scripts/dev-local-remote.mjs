// Vite dev server 的「远程仓库账号」中间件：接口与 Rust 外壳的 `/local/remote/*` 对齐。
//
// 契约见 docs/remote-accounts-contract.md（唯一真相）；这里只做 dev 侧的 Node 实现，
// 生产走外壳，同一套 JSON 结构、同一套语义。
//
// 几条硬约束（踩过就知道）：
//   * 账号文件在 `%LOCALAPPDATA%\oc-workbench\remotes.json`，**绝不能**落进项目仓库；
//   * 写入一律「同目录临时文件 + rename」，写一半崩了也不能把已有账号弄丢；
//   * 读接口永远不回传 token，只回 `hasToken: true` —— 页面内存里不该有 token；
//   * 网络请求走全局 fetch（Node 18+），统一 25s 超时，认证头统一 `Authorization: token <t>`；
//   * 仓库列表的 `q` 在**本地**过滤，别指望各站搜索参数一致；
//   * 错误一律 `{ error, status }`，error 里带中文 + 上游原文，不吞真实失败原因。
//   * 新增的 `login`（账号密码换令牌）里，密码只活到函数返回：不落盘、不写日志、
//     不进返回值，报错文案还要过一遍打码 —— 见 loginRemote 的注释。
//   * `open-url` 只放 http/https，Windows 上走 verbatim 参数数组，URL 自带引号，
//     否则 `&` 会被 cmd 当成命令分隔符。
//
// 只在 `npm run dev` 生效，打包产物不包含它。

import { mkdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'

import { httpError, readBody, sendJson, writeFileAtomic } from './dev-local-fs.mjs'

/** 网络类接口的超时：契约写死 25s。 */
const TIMEOUT_NET = 25_000
/** POST 请求体上限：契约写死 256 KB。 */
const MAX_BODY_BYTES = 256 * 1024
/** 上游错误原文在 error 里保留的长度。 */
const MAX_DETAIL = 300
/** 仓库名：只允许字母、数字、点、下划线、短横线。 */
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/
/** GitHub 官方站的 API 地址；GHE 走 `<baseUrl>/api/v3`。 */
const GITHUB_API = 'https://api.github.com'
/** 请求头：Node 的 fetch 默认 UA 是 `node`，带上自己的更礼貌，也避开个别站点的 UA 过滤。 */
const USER_AGENT = 'oc-workbench-dev'

const KINDS = new Set(['github', 'gitea'])
/** open-url 只放这两种协议；`javascript:` / `file:` / `data:` 一律拒。 */
const OPEN_URL_PROTOCOLS = new Set(['http:', 'https:'])
/** open-url 长度上限（契约 §7.2）。 */
const OPEN_URL_MAX = 2048

// ---------- 小工具 ----------

function clampInt(value, fallback, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(Math.max(Math.trunc(num), min), max)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** 上游返回的原因：优先 JSON 的 message/error 字段，退化成正文片段。 */
export function upstreamMessage(result) {
  const data = result?.data
  if (data && typeof data === 'object') {
    if (nonEmptyString(data.message)) return data.message.trim()
    if (nonEmptyString(data.error)) return data.error.trim()
    // GitHub 的「名字已存在」把原因埋在 errors[] 里
    if (Array.isArray(data.errors)) {
      const parts = data.errors
        .map((item) => (typeof item === 'string' ? item : item?.message))
        .filter(nonEmptyString)
      if (parts.length) return parts.join('；')
    }
  }
  const text = typeof result?.text === 'string' ? result.text.trim() : ''
  return text ? text.slice(0, MAX_DETAIL) : ''
}

// ---------- 账号文件 ----------

/**
 * 账号文件路径。**每次调用都读一次 env**，否则测试里换 LOCALAPPDATA 不生效。
 * 非 Windows 上 LOCALAPPDATA 不存在，退到 ~/.local/share（只影响 dev/CI，不影响产品）。
 */
export function accountsFile() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'oc-workbench', 'remotes.json')
}

/** 读全部账号（含 token，仅供服务端内部使用）。文件不存在 / 空文件 = 空数组。 */
export async function readAccounts() {
  const file = accountsFile()
  const text = await readFile(file, 'utf8').catch((err) => {
    if (err?.code === 'ENOENT') return null
    throw httpError(500, `读取账号文件失败：${err?.message ?? err}`)
  })
  if (text === null || text.trim() === '') return []

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // 绝不静默返回空数组：下一次写入会把用户已有账号整片抹掉
    throw httpError(500, `账号文件格式坏了（${file}），请手动检查或删除后重试`)
  }
  if (!Array.isArray(parsed)) {
    throw httpError(500, `账号文件格式不对（${file}），请手动检查或删除后重试`)
  }
  return parsed.filter((item) => item && typeof item === 'object' && nonEmptyString(item.id))
}

/** 原子写：临时文件 + rename，中途失败原文件保持原样。 */
export async function writeAccounts(accounts) {
  const file = accountsFile()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomic(file, `${JSON.stringify(accounts, null, 2)}\n`)
}

/** 出站形状：**剥掉 token**，只留 hasToken。 */
export function publicAccount(account) {
  return {
    id: account.id,
    kind: account.kind,
    baseUrl: account.baseUrl,
    webUrl: account.webUrl || account.baseUrl,
    username: account.username,
    hasToken: nonEmptyString(account.token),
    createdAt: Number(account.createdAt) || 0,
  }
}

/** `rm-` + 8 位十六进制；撞了就重摇，别让两个账号共用一个 id。 */
export function newAccountId(existing) {
  const used = new Set((existing ?? []).map((item) => item.id))
  for (let i = 0; i < 100; i += 1) {
    const id = `rm-${randomBytes(4).toString('hex')}`
    if (!used.has(id)) return id
  }
  throw httpError(500, '生成账号 id 失败，请重试')
}

// ---------- 纯函数：地址 / 仓库名 / 仓库映射 ----------

/**
 * 站点根地址归一化：
 *   * 去首尾空白与结尾 `/`；
 *   * 没写协议时补 `http://`（Gitea 局域网地址用户基本不会写协议）；
 *   * 顺手剥掉误粘进来的 `/api/v1`、`/api/v3` —— 那是接口地址，不是站点地址。
 */
export function normalizeBaseUrl(raw) {
  let text = String(raw ?? '').trim()
  if (!text) throw httpError(400, '缺少服务器地址')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`

  let url
  try {
    url = new URL(text)
  } catch {
    throw httpError(400, `服务器地址看起来不对：${text}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw httpError(400, '服务器地址只支持 http / https')
  }
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\/api\/v[13]$/i, '')
  return `${url.protocol}//${url.host}${pathname}`
}

/** 显式传进来的 apiBase：去尾 `/`，没协议补 http。 */
function normalizeApiBase(raw) {
  let text = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!text) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`
  return text
}

function hostOf(webUrl) {
  try {
    return new URL(webUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 只有官方 github.com（含 www）才走 api.github.com。 */
export function isGitHubDotCom(webUrl) {
  return /^(www\.)?github\.com$/.test(hostOf(webUrl))
}

/**
 * `kind + baseUrl` → API 根：
 *   * github + github.com → `https://api.github.com`
 *   * github + 其他（GHE）→ `<baseUrl>/api/v3`
 *   * gitea → `<baseUrl>/api/v1`
 */
export function deriveApiBase(kind, baseUrl) {
  const web = normalizeBaseUrl(baseUrl)
  if (kind === 'github') return isGitHubDotCom(web) ? GITHUB_API : `${web}/api/v3`
  return `${web}/api/v1`
}

/** 仓库名只允许 `[A-Za-z0-9._-]`，1~100 字；`.` / `..` 这种纯点名字不算。 */
export function isValidRepoName(name) {
  const text = typeof name === 'string' ? name : ''
  if (!REPO_NAME_RE.test(text)) return false
  if (text === '.' || text === '..') return false
  return true
}

/** 时间戳统一成「秒」；解析不了给 0。 */
function epochSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 上游偶尔直接给毫秒，按量级归一
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value)
  }
  const ms = Date.parse(String(value ?? ''))
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0
}

/**
 * 站点原始仓库对象 → 契约里的 RemoteRepo。
 * `empty` 是最有价值的信号（空仓库首推不会冲突）：
 *   github 用 `size === 0`；gitea 优先 `empty === true`，没有就退 `size === 0`。
 */
export function mapRepo(kind, raw) {
  const item = raw && typeof raw === 'object' ? raw : {}
  const owner = (item.owner && (item.owner.login || item.owner.username || item.owner.name)) || ''
  const name = nonEmptyString(item.name) ? item.name.trim() : ''
  const fullName = nonEmptyString(item.full_name) ? item.full_name.trim() : owner && name ? `${owner}/${name}` : name

  const empty =
    kind === 'gitea'
      ? item.empty === true || (item.empty === undefined && Number(item.size) === 0)
      : Number(item.size) === 0

  return {
    fullName,
    name,
    owner,
    private: item.private === true || item.visibility === 'private',
    cloneUrl: nonEmptyString(item.clone_url) ? item.clone_url : nonEmptyString(item.html_url) ? item.html_url : '',
    sshUrl: nonEmptyString(item.ssh_url) ? item.ssh_url : '',
    defaultBranch: nonEmptyString(item.default_branch) ? item.default_branch : '',
    updatedAt: epochSeconds(item.updated_at),
    empty,
  }
}

/** 空仓库排最前（首推不冲突），其余按 updatedAt 倒序；同时间按名字稳定排序。 */
export function sortRepos(repos) {
  return [...repos].sort((left, right) => {
    if (left.empty !== right.empty) return left.empty ? -1 : 1
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt
    return left.fullName.toLowerCase().localeCompare(right.fullName.toLowerCase())
  })
}

/** `q` 本地过滤：fullName 大小写不敏感包含。 */
export function filterRepos(repos, q) {
  const needle = String(q ?? '').trim().toLowerCase()
  if (!needle) return repos
  return repos.filter((repo) => repo.fullName.toLowerCase().includes(needle))
}

// ---------- HTTP ----------

/**
 * 一次 JSON 请求，**不抛业务错误**：状态码和正文原样返回，交给调用方判定。
 * 只有超时/连不上这类传输层故障直接抛（这两类没有可用的状态码）。
 *
 * `authorization` 是**整条**认证头，用于账号密码换令牌的 Basic 认证；
 * 它只在本次请求的内存里存在，任何错误文案都不会带上它。
 */
async function requestJson(
  url,
  { method = 'GET', token = '', authorization = '', body = null, timeoutMs = TIMEOUT_NET } = {},
) {
  const headers = {
    accept: 'application/json',
    'user-agent': USER_AGENT,
  }
  if (authorization) headers.authorization = authorization
  else if (token) headers.authorization = `token ${token}`

  let payload
  if (body !== null) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw networkError(url, err, timeoutMs)
  }

  let text = ''
  try {
    // 204 / 空 body 保持空串，别 JSON.parse('')
    text = await res.text()
  } catch {
    text = ''
  }

  let data = null
  if (text.trim() !== '') {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  return { ok: res.ok, status: res.status, data, text }
}

function networkError(url, err, timeoutMs) {
  const seconds = Math.round(timeoutMs / 1000)
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return httpError(504, `请求超时（${seconds} 秒），检查服务器地址和网络`)
  }
  const host = hostOf(url) || url
  const cause = err?.cause?.message || err?.message || 'unknown'
  return httpError(502, `连不上 ${host}，检查地址和网络：${cause}`)
}

/** 非 2xx → 中文原因 + 上游原文，状态码沿用上游（401/404/409 有专门文案）。 */
function ensureOk(result) {
  if (result.ok) return result
  const detail = upstreamMessage(result)
  const status = result.status || 500
  const base =
    status === 401
      ? 'token 无效或已过期'
      : status === 404
        ? '接口不存在，确认是 Gitea 而不是别的服务'
        : status === 409
          ? '仓库已存在'
          : `上游返回 ${status}`
  throw httpError(status, detail ? `${base}：${detail}` : base)
}

// ---------- 探测 / 账号 ----------

/** 认服务类型：github.com → github；否则看 `<baseUrl>/api/v1/version` 有没有 version。 */
export async function detectKind(baseUrl) {
  const web = normalizeBaseUrl(baseUrl)
  if (isGitHubDotCom(web)) return 'github'
  const result = await requestJson(`${web}/api/v1/version`, { timeoutMs: TIMEOUT_NET })
  if (result.ok && result.data && nonEmptyString(result.data.version)) return 'gitea'
  return ''
}

/** 拿 `/user`：GitHub 和 Gitea 都接受 `Authorization: token <t>`。 */
async function fetchUser(apiBase, token) {
  const result = await requestJson(`${apiBase}/user`, { token })
  const data = ensureOk(result).data
  const item = data && typeof data === 'object' ? data : {}
  return {
    username: String(item.login || item.username || '').trim(),
    name: String(item.full_name || item.name || '').trim(),
  }
}

/** POST /local/remote/probe */
export async function probeRemote({ baseUrl, token = '', kind = '' } = {}) {
  const web = normalizeBaseUrl(baseUrl)
  const secret = String(token ?? '').trim()
  if (!secret) throw httpError(400, '缺少 token')

  const wanted = String(kind ?? '').trim()
  const realKind = KINDS.has(wanted) ? wanted : await detectKind(web)
  if (!realKind) throw httpError(400, '认不出这是 GitHub 还是 Gitea')

  const apiBase = deriveApiBase(realKind, web)
  const user = await fetchUser(apiBase, secret)
  if (!user.username) throw httpError(400, '这个 token 读不到账号名，确认 token 权限（GitHub 勾 repo，Gitea 勾 repository）')

  const payload = { kind: realKind, webUrl: web, apiBase, username: user.username }
  if (user.name) payload.name = user.name
  return payload
}

/** GET /local/remote/accounts */
export async function listAccounts() {
  const accounts = await readAccounts()
  // 按创建时间倒序：最近加的排前面，前端不用再排
  const sorted = [...accounts].sort((left, right) => (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0))
  return { accounts: sorted.map(publicAccount) }
}

/** POST /local/remote/accounts */
export async function saveAccount(body = {}) {
  const baseUrl = normalizeBaseUrl(body?.baseUrl)
  const token = String(body?.token ?? '').trim()
  if (!token) throw httpError(400, '缺少 token')

  const wanted = String(body?.kind ?? '').trim()
  let kind = KINDS.has(wanted) ? wanted : ''
  let apiBase = ''
  let username = String(body?.username ?? '').trim()

  if (!kind) {
    // 没指定类型：等价于先 probe 一次（顺带验了 token）
    const probed = await probeRemote({ baseUrl, token, kind: '' })
    kind = probed.kind
    apiBase = probed.apiBase
    if (!username) username = probed.username
  } else {
    const explicit = normalizeApiBase(body?.apiBase)
    apiBase = explicit || deriveApiBase(kind, baseUrl)
    if (!username) {
      // 契约：username 空就调一次 /user 拿 login
      const user = await fetchUser(apiBase, token)
      username = user.username
    }
  }

  if (!username) throw httpError(400, '拿不到账号名，请填 username 或确认 token 有效')

  const accounts = await readAccounts()
  const now = Date.now()
  const index = accounts.findIndex(
    (item) => item.kind === kind && item.apiBase === apiBase && item.username === username,
  )

  let account
  if (index >= 0) {
    // 同名账号更新而不是新增：id 保持不变，前端选中项不会跳
    account = { ...accounts[index], baseUrl, webUrl: baseUrl, token, createdAt: now }
    accounts[index] = account
  } else {
    account = {
      id: newAccountId(accounts),
      kind,
      baseUrl,
      apiBase,
      webUrl: baseUrl,
      username,
      token,
      createdAt: now,
    }
    accounts.push(account)
  }

  await writeAccounts(accounts)
  return { account: publicAccount(account) }
}

// ---------- 账号密码换令牌 ----------

/** 默认令牌名：`oc-workbench-YYYY-MM-DD`（本地日期，和契约示例一致）。 */
export function defaultTokenName(now = new Date()) {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  // 紧凑格式无分隔符：Rust 外壳那边是 oc-workbench-{YYYY}{MM}{DD}，
  // 两端必须逐字一致，否则同一天会生成两个不同名字的令牌。
  return `oc-workbench-${year}${month}${day}`
}

/** `Basic base64(user:pass)` —— 只在内存里拼，不缓存、不落盘、不进日志。 */
function basicAuth(username, password) {
  const raw = Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
  return `Basic ${raw}`
}

/** 兜底：任何往外抛的文案里如果混进了密码原文，就地打码。 */
function scrubPassword(message, password) {
  const text = String(message ?? '')
  if (!password || !text.includes(password)) return text
  return text.split(password).join('***')
}

/**
 * POST /local/remote/login —— Gitea 账号密码换令牌（契约 §7.1）。
 *
 * 安全约束（硬要求）：
 *   * 密码只活在本次调用的局部变量里，拼完 Basic 头就随作用域结束；
 *   * 不写文件、不写日志、**不出现在返回值里**；
 *   * 报错前统一过 `scrubPassword`，连上游回声都不会把密码带出去。
 */
export async function loginRemote(body = {}) {
  // 密码不 trim：首尾空格可能是密码的一部分，trim 掉会变成「密码不对」
  const password = typeof body?.password === 'string' ? body.password : ''
  const username = String(body?.username ?? '').trim()
  const web = normalizeBaseUrl(body?.baseUrl)

  if (!username) throw httpError(400, '请填 Gitea 用户名')
  if (!password) throw httpError(400, '请填密码')

  try {
    const wanted = String(body?.kind ?? '').trim()
    const probed = KINDS.has(wanted) ? wanted : await detectKind(web)
    if (!probed) throw httpError(400, '认不出这是 GitHub 还是 Gitea')
    if (probed === 'github') throw httpError(400, 'GitHub 不支持账号密码登录，请用令牌')

    const apiBase = deriveApiBase(probed, web)
    const tokenName = String(body?.tokenName ?? '').trim() || defaultTokenName()

    // 契约：不传 scopes —— 老版本 Gitea 不认这个字段，不传等于全权限
    const result = await requestJson(`${apiBase}/users/${encodeURIComponent(username)}/tokens`, {
      method: 'POST',
      authorization: basicAuth(username, password),
      body: { name: tokenName },
    })

    if (!result.ok) {
      const detail = upstreamMessage(result)
      const status = result.status || 500
      if (status === 401) throw httpError(401, detail ? `用户名或密码不对：${detail}` : '用户名或密码不对')
      if (status === 403) {
        throw httpError(
          403,
          detail ? `这个账号没有创建访问令牌的权限：${detail}` : '这个账号没有创建访问令牌的权限',
        )
      }
      if (status === 404) throw httpError(404, '这个 Gitea 版本不支持用接口创建令牌，请改用令牌方式')
      throw httpError(status, detail ? `上游返回 ${status}：${detail}` : `上游返回 ${status}`)
    }

    const sha1 = result.data && typeof result.data === 'object' ? result.data.sha1 : ''
    const token = nonEmptyString(sha1) ? sha1.trim() : ''
    if (!token) throw httpError(502, 'Gitea 没有返回令牌，确认这个账号有创建访问令牌的权限')

    // 用新令牌再验一次 `/user`：令牌真能用才写进账号文件
    const user = await fetchUser(apiBase, token)
    const login = user.username || username

    // 「令牌按现有 POST /accounts 的规则保存」：同名更新，不新增
    await saveAccount({ kind: probed, baseUrl: web, apiBase, token, username: login })

    const payload = {
      kind: probed,
      baseUrl: web,
      apiBase,
      webUrl: web,
      username: login,
      token,
      tokenName,
    }
    if (user.name) payload.name = user.name
    return payload
  } catch (err) {
    // 只改文案，不改状态码；密码原文不可能走到调用方
    if (err && typeof err.message === 'string') err.message = scrubPassword(err.message, password)
    throw err
  }
}

// ---------- 打开系统浏览器 ----------

/** 协议白名单 + 长度上限；返回校验后的原串。 */
export function assertOpenableUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) throw httpError(400, '缺少要打开的地址')
  if (text.length > OPEN_URL_MAX) throw httpError(400, `地址太长（上限 ${OPEN_URL_MAX} 字符）`)
  if (/[\u0000-\u001f\u007f]/.test(text)) throw httpError(400, '地址里不能有控制字符')

  let url
  try {
    url = new URL(text)
  } catch {
    throw httpError(400, `地址看起来不对：${text.slice(0, 120)}`)
  }
  if (!OPEN_URL_PROTOCOLS.has(url.protocol)) throw httpError(400, '只支持 http / https 地址')
  return text
}

/**
 * 平台命令。Windows 上必须让 URL 自己带引号：
 * `cmd` 会把**未加引号**的 `&` 当命令分隔符，GitHub 令牌页正好带 `&`。
 * 所以整条命令行走 verbatim，参数数组里直接把引号写好。
 */
export function buildOpenCommand(url, platform = process.platform) {
  if (platform === 'win32') {
    const safe = url.replace(/"/g, '%22')
    return { command: 'cmd', args: ['/c', 'start', '""', `"${safe}"`], verbatim: true }
  }
  if (platform === 'darwin') return { command: 'open', args: [url], verbatim: false }
  return { command: 'xdg-open', args: [url], verbatim: false }
}

/**
 * POST /local/remote/open-url —— 让系统默认浏览器打开（契约 §7.2）。
 * `spawnFn` 只为测试注入，生产走真 spawn。
 */
export async function openRemoteUrl(body = {}, { spawnFn = spawn } = {}) {
  const url = assertOpenableUrl(body?.url)
  const { command, args, verbatim } = buildOpenCommand(url)

  await new Promise((resolve, reject) => {
    let child
    try {
      child = spawnFn(command, args, {
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        detached: true,
        stdio: 'ignore',
      })
    } catch (err) {
      reject(err)
      return
    }

    const onError = (err) => {
      child.removeListener?.('spawn', onSpawn)
      reject(err)
    }
    const onSpawn = () => {
      child.removeListener?.('error', onError)
      // 拉起的浏览器不该拖着 dev server 的生命周期
      child.unref?.()
      resolve()
    }
    child.once('error', onError)
    child.once('spawn', onSpawn)
  }).catch((err) => {
    throw httpError(500, `打开浏览器失败：${err?.message ?? err}`)
  })

  return { ok: true }
}

/** DELETE /local/remote/accounts?id=... */
export async function deleteAccount(id) {
  const key = String(id ?? '').trim()
  if (!key) throw httpError(400, '缺少要删除的账号 id')
  const accounts = await readAccounts()
  const kept = accounts.filter((item) => item.id !== key)
  if (kept.length === accounts.length) throw httpError(404, '没有这个账号')
  await writeAccounts(kept)
  return { ok: true }
}

/** 按 id 取账号（内部用，带 token）。 */
async function requireAccount(id) {
  const key = String(id ?? '').trim()
  if (!key) throw httpError(400, '缺少 account 参数')
  const accounts = await readAccounts()
  const account = accounts.find((item) => item.id === key)
  if (!account) throw httpError(404, '没有这个账号')
  if (!nonEmptyString(account.token)) throw httpError(400, '这个账号没有保存 token，请重新添加')
  return account
}

// ---------- 仓库 ----------

/** GET /local/remote/repos */
export async function listRemoteRepos({ account: accountId, q = '', limit } = {}) {
  const account = await requireAccount(accountId)
  const count = clampInt(limit, 100, 1, 500)

  const url =
    account.kind === 'github'
      ? `${account.apiBase}/user/repos?per_page=${count}&sort=updated&affiliation=owner,collaborator,organization_member`
      : `${account.apiBase}/user/repos?limit=${count}&page=1`

  const result = ensureOk(await requestJson(url, { token: account.token }))
  const raw = Array.isArray(result.data) ? result.data : []
  const repos = sortRepos(raw.map((item) => mapRepo(account.kind, item)))
  return { repos: filterRepos(repos, q) }
}

/** POST /local/remote/create */
export async function createRemoteRepo({ account: accountId, name, private: isPrivate, description } = {}) {
  const repoName = String(name ?? '').trim()
  if (!isValidRepoName(repoName)) {
    throw httpError(400, '仓库名只能用字母、数字、点、下划线、短横线')
  }

  const account = await requireAccount(accountId)
  const url = `${account.apiBase}/user/repos`
  const result = await requestJson(url, {
    method: 'POST',
    token: account.token,
    body: {
      name: repoName,
      private: isPrivate === true,
      description: String(description ?? '').trim(),
      // 必须 false：远端带初始提交会让本地首推变成 non-fast-forward
      auto_init: false,
    },
  })

  if (!result.ok) {
    // GitHub 建重名仓库给 422（原因在 errors[]），Gitea 给 409 —— 统一成 409
    const detail = upstreamMessage(result)
    if (result.status === 409 || result.status === 422) {
      throw httpError(409, detail ? `仓库已存在：${detail}` : '仓库已存在')
    }
    ensureOk(result)
  }

  return { repo: mapRepo(account.kind, result.data) }
}

// ---------- 路由 ----------

/** 接口表：action → { method → handler }。GET/POST/DELETE 同名不同法。 */
const ROUTES = {
  accounts: {
    GET: () => listAccounts(),
    POST: ({ body }) => saveAccount(body),
    DELETE: ({ query }) => deleteAccount(query.get('id')),
  },
  probe: { POST: ({ body }) => probeRemote(body) },
  repos: {
    GET: ({ query }) =>
      listRemoteRepos({
        account: query.get('account'),
        q: query.get('q') ?? '',
        limit: query.get('limit') ?? undefined,
      }),
  },
  create: { POST: ({ body }) => createRemoteRepo(body) },
  login: { POST: ({ body }) => loginRemote(body) },
  // 契约路由是 `/local/remote/open-url`；两种写法都收，前端不用猜
  openUrl: { POST: ({ body }) => openRemoteUrl(body) },
  'open-url': { POST: ({ body }) => openRemoteUrl(body) },
}

const METHOD_LABEL = { GET: 'GET', POST: 'POST', DELETE: 'DELETE' }

/**
 * 内部入口：不起 HTTP，直接按 action 调实现（测试与中间件共用同一条路）。
 * 返回值就是直接写进响应的 JSON 对象；失败抛 `{ status, message }`。
 */
export async function remoteApi({ method = 'GET', action, query, body = null } = {}) {
  const route = Object.prototype.hasOwnProperty.call(ROUTES, action) ? ROUTES[action] : null
  if (!route) throw httpError(404, '未知的本地远程账号接口')

  const verb = String(method ?? 'GET').toUpperCase()
  const handler = route[verb]
  if (!handler) {
    const allowed = Object.keys(route).map((key) => METHOD_LABEL[key] ?? key)
    throw httpError(405, `这个接口只支持 ${allowed.join(' / ')}`)
  }
  return handler({
    query: query ?? new URLSearchParams(),
    body: body && typeof body === 'object' ? body : {},
  })
}

/** POST 的 JSON body；其余返回 null。 */
async function readJsonBody(req) {
  if ((req.method || 'GET') !== 'POST') return null
  let raw
  try {
    raw = await readBody(req, MAX_BODY_BYTES)
  } catch (err) {
    // readBody 的 413 文案是给保存文件用的（写着 8MB），这里按远程账号的上限改写
    if (err.status === 413) throw httpError(413, '请求体太大（上限 256KB）')
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
  const method = (req.method || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
    throw httpError(405, '只支持 GET / POST / DELETE')
  }
  const url = new URL(req.url, 'http://127.0.0.1')
  const action = url.pathname.replace(/^\/local\/remote\/?/, '')
  const body = await readJsonBody(req)
  const result = await remoteApi({ method, action, query: url.searchParams, body })
  sendJson(res, 200, result)
}

/**
 * 只拦 `/local/remote` 前缀，其余请求原样交给 Vite。
 *
 * 注意挂载顺序：`localFsPlugin` 拦的是所有 `/local/*`，所以 vite.config.ts 里
 * 必须是 `[react(), localGitPlugin(), localRemotePlugin(), localFsPlugin()]`，
 * 否则 `/local/remote/accounts` 会先被 fs 插件接走，报「未知的本地文件接口」。
 */
export function localRemotePlugin() {
  return {
    name: 'oc-workbench-local-remote',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || ''
        if (url !== '/local/remote' && !url.startsWith('/local/remote/')) {
          next()
          return
        }
        handle(req, res).catch((err) => {
          const status = err.status || 500
          const message = err.status
            ? err.message
            : `远程账号操作失败（${err.code || err.message || 'unknown'}）`
          sendJson(res, status, { error: message, status })
        })
      })
    },
  }
}
