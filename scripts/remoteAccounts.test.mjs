// 远程账号 dev 后端（scripts/dev-local-remote.mjs）的回归。
//
// 分三层：
//   1. 纯函数（apiBase 推导 / 地址归一化 / 仓库名校验 / 仓库映射 / 排序 / 过滤）—— 不碰磁盘；
//   2. 存储 —— 每个用例独立的临时 LOCALAPPDATA，验证存/读/删/同名更新/原子写/token 不外泄；
//   3. 真链路 —— node:http 起假 Gitea（127.0.0.1:0），跑通 probe → 保存 → repos → create。
//      **绝不连真站**：所有请求都打 127.0.0.1 的随机端口。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  accountsFile,
  assertOpenableUrl,
  buildOpenCommand,
  createRemoteRepo,
  defaultTokenName,
  deleteAccount,
  deriveApiBase,
  filterRepos,
  isValidRepoName,
  listAccounts,
  listRemoteRepos,
  loginRemote,
  mapRepo,
  normalizeBaseUrl,
  openRemoteUrl,
  probeRemote,
  readAccounts,
  remoteApi,
  saveAccount,
  sortRepos,
} from './dev-local-remote.mjs'

// ---------- 夹具 ----------

/** 每个用例自己的临时 LOCALAPPDATA，跑完还原环境变量并整棵删掉。 */
async function tempLocalAppData(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocwb-remote-'))
  const previous = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = dir
  t.after(async () => {
    if (previous === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  return dir
}

/** 返回值里既不能有 token 字符串，也不能有 token 字段（嵌套层级一起查）。 */
function assertNoToken(payload, secret) {
  const text = JSON.stringify(payload)
  assert.ok(!text.includes(secret), `返回值里出现了 token：${text}`)
  const walk = (value) => {
    if (!value || typeof value !== 'object') return
    assert.ok(!Object.prototype.hasOwnProperty.call(value, 'token'), '返回值里出现了 token 字段')
    for (const item of Array.isArray(value) ? value : Object.values(value)) walk(item)
  }
  walk(payload)
}

/** 起一个只回固定响应的桩服务，用来测 404/连不上这类分支。 */
async function startStubServer(t, handler) {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}

/**
 * 假 Gitea：只实现契约用到的 5 个接口。
 *   GET  /api/v1/version              公开，返回 version 字段（探测靠它）
 *   POST /api/v1/users/{name}/tokens  收 Basic 认证（用户名 + 密码），发一个令牌
 *   GET  /api/v1/user                 要 `Authorization: token <token>`（真令牌或发的令牌都认）
 *   GET  /api/v1/user/repos           返回内存里的仓库
 *   POST /api/v1/user/repos           建仓库，重名 409
 * 其余路径 404；所有请求体都记进 state.calls，供断言 auto_init 之类。
 */
async function startFakeGitea(t, options = {}) {
  const token = options.token ?? 'gitea-test-token'
  const login = options.login ?? 'luyongkang777'
  const password = options.password ?? 'gitea-pass-123'
  const state = { repos: [], calls: [], nextId: 1, origin: '', tokens: new Set(), tokenSeq: 1 }

  const send = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }

  const rawRepo = (name, { empty = true, priv = false, updatedAt = new Date().toISOString() } = {}) => ({
    id: state.nextId++,
    name,
    full_name: `${login}/${name}`,
    owner: { login, username: login },
    private: priv,
    clone_url: `${state.origin}/${login}/${name}.git`,
    ssh_url: `git@127.0.0.1:${login}/${name}.git`,
    default_branch: 'main',
    updated_at: updatedAt,
    empty,
    size: empty ? 0 : 8,
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = null
    if (raw.trim()) {
      try {
        body = JSON.parse(raw)
      } catch {
        body = null
      }
    }
    state.calls.push({ method: req.method, path: url.pathname, search: url.search, body })

    if (req.method === 'GET' && url.pathname === '/api/v1/version') {
      send(res, 200, { version: '1.22.0' })
      return
    }
    if (!url.pathname.startsWith('/api/v1/')) {
      send(res, 404, { message: 'not found' })
      return
    }

    // 账号密码换令牌：只收 Basic，用户名密码对上才发令牌（Gitea 就是这么回的）
    const tokensRoute = url.pathname.match(/^\/api\/v1\/users\/([^/]+)\/tokens$/)
    if (req.method === 'POST' && tokensRoute) {
      const name = decodeURIComponent(tokensRoute[1])
      const auth = String(req.headers.authorization ?? '')
      const decoded = auth.startsWith('Basic ')
        ? Buffer.from(auth.slice(6), 'base64').toString('utf8')
        : ''
      const colon = decoded.indexOf(':')
      const user = colon >= 0 ? decoded.slice(0, colon) : ''
      const pass = colon >= 0 ? decoded.slice(colon + 1) : ''

      if (user !== name || user !== login || pass !== password) {
        send(res, 401, { message: 'invalid username, password or token' })
        return
      }

      const issued = `generated-token-${state.tokenSeq++}`
      state.tokens.add(issued)
      send(res, 201, {
        id: 3,
        name: String(body?.name ?? ''),
        sha1: issued,
        token_last_eight: issued.slice(-8),
      })
      return
    }

    const auth = String(req.headers.authorization ?? '')
    const bearer = auth.startsWith('token ') ? auth.slice(6) : ''
    if (!(auth === `token ${token}` || (bearer && state.tokens.has(bearer)))) {
      send(res, 401, { message: 'token is required' })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/user') {
      send(res, 200, { login, username: login, full_name: '陆永康' })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/user/repos') {
      const limit = Number(url.searchParams.get('limit') ?? 50)
      send(res, 200, state.repos.slice(0, Number.isFinite(limit) ? limit : 50))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/user/repos') {
      const name = String(body?.name ?? '').trim()
      if (!name) {
        send(res, 422, { message: 'name is required' })
        return
      }
      if (state.repos.some((repo) => repo.name === name)) {
        send(res, 409, { message: 'repository already exists' })
        return
      }
      const created = rawRepo(name, {
        // auto_init 必须显式 false；带了初始提交就不算空仓库
        empty: body?.auto_init !== true,
        priv: body?.private === true,
      })
      state.repos.push(created)
      send(res, 201, created)
      return
    }
    send(res, 404, { message: 'not found' })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  state.origin = `http://127.0.0.1:${server.address().port}`

  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  })

  return { baseUrl: state.origin, token, login, password, state, rawRepo }
}

// ---------- 纯函数 ----------

test('apiBase 推导：github.com / GHE / gitea', () => {
  assert.equal(deriveApiBase('github', 'https://github.com'), 'https://api.github.com')
  assert.equal(deriveApiBase('github', 'https://github.com/'), 'https://api.github.com')
  assert.equal(deriveApiBase('github', 'https://www.github.com'), 'https://api.github.com')

  // GitHub Enterprise：站点根 + /api/v3
  assert.equal(deriveApiBase('github', 'https://git.corp.example.com'), 'https://git.corp.example.com/api/v3')
  assert.equal(
    deriveApiBase('github', 'https://git.corp.example.com/git/'),
    'https://git.corp.example.com/git/api/v3',
  )

  // Gitea：站点根 + /api/v1
  assert.equal(deriveApiBase('gitea', 'http://192.168.31.8:3000'), 'http://192.168.31.8:3000/api/v1')
  assert.equal(deriveApiBase('gitea', 'http://192.168.31.8:3000/'), 'http://192.168.31.8:3000/api/v1')

  // 误把接口地址当站点地址粘进来：剥掉，绝不出现 /api/v1/api/v1
  assert.equal(deriveApiBase('gitea', 'http://192.168.31.8:3000/api/v1'), 'http://192.168.31.8:3000/api/v1')
  assert.equal(deriveApiBase('github', 'https://github.com/api/v3'), 'https://api.github.com')
})

test('服务器地址归一化', () => {
  // 没写协议 → 补 http://（局域网 Gitea 基本不会写协议）
  assert.equal(normalizeBaseUrl('192.168.31.8:3000'), 'http://192.168.31.8:3000')
  assert.equal(normalizeBaseUrl('  https://github.com/  '), 'https://github.com')
  assert.equal(normalizeBaseUrl('http://host:3000/gitea/'), 'http://host:3000/gitea')

  assert.throws(() => normalizeBaseUrl(''), (err) => err.status === 400)
  assert.throws(() => normalizeBaseUrl('   '), (err) => err.status === 400)
  assert.throws(() => normalizeBaseUrl('ftp://host'), (err) => err.status === 400)
})

test('仓库名校验：正例与反例', () => {
  for (const name of ['oc-workbench', 'a.b_c-1', 'A1', 'x'.repeat(100), '2024.11.13']) {
    assert.equal(isValidRepoName(name), true, `应通过：${name}`)
  }
  for (const name of ['', ' ', 'a b', 'a/b', 'a@b', 'x'.repeat(101), '中文仓库', '.', '..', 'a\nb', null, 42]) {
    assert.equal(isValidRepoName(name), false, `应拒绝：${String(name)}`)
  }
})

test('empty 判定：GitHub 看 size，Gitea 优先看 empty 字段', () => {
  // GitHub：size === 0 才是空仓库
  assert.equal(mapRepo('github', { name: 'a', full_name: 'me/a', size: 0 }).empty, true)
  assert.equal(mapRepo('github', { name: 'a', full_name: 'me/a', size: 32 }).empty, false)

  // Gitea：empty: true 直接算空
  assert.equal(mapRepo('gitea', { name: 'a', full_name: 'me/a', empty: true, size: 0 }).empty, true)
  // Gitea 老版本不给 empty 字段 → 退化成 size === 0
  assert.equal(mapRepo('gitea', { name: 'a', full_name: 'me/a', size: 0 }).empty, true)
  assert.equal(mapRepo('gitea', { name: 'a', full_name: 'me/a', size: 4 }).empty, false)
  // 明确 empty: false 时不因 size 误判
  assert.equal(mapRepo('gitea', { name: 'a', full_name: 'me/a', empty: false, size: 0 }).empty, false)

  // 字段映射：owner / clone / ssh / 秒级时间戳
  const repo = mapRepo('gitea', {
    name: 'oc-workbench',
    full_name: 'luyongkang777/oc-workbench',
    owner: { login: 'luyongkang777' },
    private: false,
    clone_url: 'http://192.168.31.8:3000/luyongkang777/oc-workbench.git',
    ssh_url: 'git@192.168.31.8:luyongkang777/oc-workbench.git',
    default_branch: 'main',
    updated_at: '2026-11-13T02:46:09Z',
    empty: false,
    size: 12,
  })
  assert.deepEqual(repo, {
    fullName: 'luyongkang777/oc-workbench',
    name: 'oc-workbench',
    owner: 'luyongkang777',
    private: false,
    cloneUrl: 'http://192.168.31.8:3000/luyongkang777/oc-workbench.git',
    sshUrl: 'git@192.168.31.8:luyongkang777/oc-workbench.git',
    defaultBranch: 'main',
    updatedAt: Math.floor(Date.parse('2026-11-13T02:46:09Z') / 1000),
    empty: false,
  })

  // 拿不到 ssh_url 就给空串，不是 undefined
  assert.equal(mapRepo('github', { name: 'a', full_name: 'me/a', size: 1 }).sshUrl, '')
  assert.equal(mapRepo('github', { name: 'a', full_name: 'me/a', size: 1 }).owner, '')
})

test('排序：空仓库排前，其余按 updatedAt 倒序', () => {
  const sorted = sortRepos([
    { fullName: 'a/full-old', empty: false, updatedAt: 100 },
    { fullName: 'a/empty-old', empty: true, updatedAt: 50 },
    { fullName: 'a/full-new', empty: false, updatedAt: 300 },
    { fullName: 'a/empty-new', empty: true, updatedAt: 200 },
  ])
  assert.deepEqual(
    sorted.map((repo) => repo.fullName),
    ['a/empty-new', 'a/empty-old', 'a/full-new', 'a/full-old'],
  )

  // 本地过滤：fullName 大小写不敏感包含；空 q 原样返回
  assert.deepEqual(
    filterRepos(sorted, 'EMPTY-NEW').map((repo) => repo.fullName),
    ['a/empty-new'],
  )
  assert.equal(filterRepos(sorted, '   ').length, 4)
  assert.equal(filterRepos(sorted, 'nothing').length, 0)
})

// ---------- 存储 ----------

test('账号存/读/删：token 永不回传，同名更新而不是新增', async (t) => {
  const dir = await tempLocalAppData(t)

  // 文件不存在 = 空数组，不报错
  assert.deepEqual(await listAccounts(), { accounts: [] })

  const first = await saveAccount({
    kind: 'gitea',
    baseUrl: 'http://192.168.31.8:3000/',
    token: 'secret-one',
    username: 'alice',
  })
  assert.match(first.account.id, /^rm-[0-9a-f]{8}$/)
  assert.equal(first.account.hasToken, true)
  assert.equal(first.account.webUrl, 'http://192.168.31.8:3000')
  assertNoToken(first, 'secret-one')

  const second = await saveAccount({
    kind: 'gitea',
    baseUrl: 'http://192.168.31.8:3000',
    token: 'secret-two',
    username: 'bob',
  })
  assert.notEqual(second.account.id, first.account.id)

  let listed = await listAccounts()
  assert.equal(listed.accounts.length, 2)
  assertNoToken(listed, 'secret-one')
  assertNoToken(listed, 'secret-two')

  // 同 kind + apiBase + username → 更新（id 不变、token 换掉、数量还是 2）
  const again = await saveAccount({
    kind: 'gitea',
    baseUrl: 'http://192.168.31.8:3000',
    token: 'secret-three',
    username: 'alice',
  })
  assert.equal(again.account.id, first.account.id)
  assert.equal(again.account.createdAt >= first.account.createdAt, true)

  listed = await listAccounts()
  assert.equal(listed.accounts.length, 2)
  assertNoToken(listed, 'secret-three')

  // 磁盘上确实存了 token（服务端要用），但只在 LOCALAPPDATA 下
  const file = accountsFile()
  assert.ok(file.startsWith(dir), `账号文件应在临时 LOCALAPPDATA 下：${file}`)
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(onDisk.length, 2)
  assert.equal(onDisk.find((item) => item.id === first.account.id).token, 'secret-three')

  // 原子写不留临时文件
  const leftovers = await readdir(path.join(dir, 'oc-workbench'))
  assert.deepEqual(leftovers.sort(), ['remotes.json'])

  // 删除
  assert.deepEqual(await deleteAccount(first.account.id), { ok: true })
  assert.equal((await readAccounts()).length, 1)
  await assert.rejects(
    () => deleteAccount(first.account.id),
    (err) => err.status === 404 && /没有这个账号/.test(err.message),
  )
})

test('账号文件损坏时报错，而不是当空数组（否则下次写入会抹掉已有账号）', async (t) => {
  const dir = await tempLocalAppData(t)
  await mkdir(path.join(dir, 'oc-workbench'), { recursive: true })
  await writeFile(path.join(dir, 'oc-workbench', 'remotes.json'), '{ this is not json', 'utf8')

  await assert.rejects(
    () => listAccounts(),
    (err) => err.status === 500 && /账号文件格式坏了/.test(err.message),
  )
  // 原文件必须原封不动
  const text = await readFile(path.join(dir, 'oc-workbench', 'remotes.json'), 'utf8')
  assert.equal(text, '{ this is not json')
})

test('saveAccount 参数校验与默认值', async (t) => {
  await tempLocalAppData(t)

  await assert.rejects(
    () => saveAccount({ kind: 'gitea', baseUrl: 'http://h:3000', token: '   ', username: 'a' }),
    (err) => err.status === 400 && /缺少 token/.test(err.message),
  )
  await assert.rejects(
    () => saveAccount({ kind: 'gitea', baseUrl: '', token: 'x', username: 'a' }),
    (err) => err.status === 400 && /缺少服务器地址/.test(err.message),
  )

  // 显式 apiBase 优先于推导，且结尾 / 被去掉
  const saved = await saveAccount({
    kind: 'github',
    baseUrl: 'https://git.corp.example.com',
    token: 'x',
    username: 'carol',
    apiBase: 'https://git.corp.example.com/api/v3/',
  })
  const [stored] = await readAccounts()
  assert.equal(stored.apiBase, 'https://git.corp.example.com/api/v3')
  assert.equal(saved.account.kind, 'github')
})

test('remoteApi 路由：方法不匹配 405，未知 action 404，DELETE 走 query', async (t) => {
  await tempLocalAppData(t)
  const saved = await saveAccount({
    kind: 'gitea',
    baseUrl: 'http://192.168.31.8:3000',
    token: 'x',
    username: 'alice',
  })

  const listed = await remoteApi({ method: 'GET', action: 'accounts' })
  assert.equal(listed.accounts.length, 1)
  assertNoToken(listed, 'x')

  await assert.rejects(
    () => remoteApi({ method: 'GET', action: 'probe' }),
    (err) => err.status === 405 && /只支持 POST/.test(err.message),
  )
  await assert.rejects(
    () => remoteApi({ method: 'GET', action: 'nope' }),
    (err) => err.status === 404,
  )
  await assert.rejects(
    () => remoteApi({ method: 'GET', action: 'repos' }),
    (err) => err.status === 400 && /缺少 account 参数/.test(err.message),
  )

  const deleted = await remoteApi({
    method: 'DELETE',
    action: 'accounts',
    query: new URLSearchParams({ id: saved.account.id }),
  })
  assert.deepEqual(deleted, { ok: true })
})

// ---------- 假 Gitea 全链路 ----------

test('假 Gitea：probe 自动识别 → 保存 → repos → create', async (t) => {
  await tempLocalAppData(t)
  const gitea = await startFakeGitea(t)

  // 预置三个仓库：一个空（最老）、一个非空（最新）、一个非空（最老）
  gitea.state.repos.push(
    gitea.rawRepo('alpha', { empty: false, updatedAt: '2024-01-01T00:00:00Z' }),
    gitea.rawRepo('beta', { empty: true, updatedAt: '2023-01-01T00:00:00Z' }),
    gitea.rawRepo('gamma', { empty: false, updatedAt: '2024-06-01T00:00:00Z' }),
  )

  // 1) probe：kind 留空 → 靠 /api/v1/version 认出 gitea
  const probed = await probeRemote({ baseUrl: gitea.baseUrl, token: gitea.token, kind: '' })
  assert.deepEqual(probed, {
    kind: 'gitea',
    webUrl: gitea.baseUrl,
    apiBase: `${gitea.baseUrl}/api/v1`,
    username: gitea.login,
    name: '陆永康',
  })
  assertNoToken(probed, gitea.token)
  assert.ok(gitea.state.calls.some((call) => call.path === '/api/v1/version'))
  assert.ok(gitea.state.calls.some((call) => call.path === '/api/v1/user'))

  // 2) 保存：username 留空 → 后端调 /user 拿 login
  const saved = await saveAccount({
    kind: 'gitea',
    baseUrl: gitea.baseUrl,
    token: gitea.token,
    username: '',
  })
  assert.equal(saved.account.username, gitea.login)
  assert.equal(saved.account.hasToken, true)
  assertNoToken(saved, gitea.token)
  const [stored] = await readAccounts()
  assert.equal(stored.apiBase, `${gitea.baseUrl}/api/v1`)

  // 3) repos：空仓库排前，其余 updatedAt 倒序
  const listed = await listRemoteRepos({ account: stored.id })
  assert.deepEqual(
    listed.repos.map((repo) => repo.fullName),
    [`${gitea.login}/beta`, `${gitea.login}/gamma`, `${gitea.login}/alpha`],
  )
  assert.equal(listed.repos[0].empty, true)
  assert.equal(listed.repos[0].cloneUrl, `${gitea.baseUrl}/${gitea.login}/beta.git`)
  // 请求按契约带 limit=100&page=1
  const reposCall = gitea.state.calls.find((call) => call.method === 'GET' && call.path === '/api/v1/user/repos')
  assert.match(reposCall.search, /limit=100/)
  assert.match(reposCall.search, /page=1/)

  // q 由后端本地过滤
  const filtered = await listRemoteRepos({ account: stored.id, q: 'GAMMA' })
  assert.deepEqual(filtered.repos.map((repo) => repo.fullName), [`${gitea.login}/gamma`])

  // 4) create：必须 auto_init: false
  const created = await createRemoteRepo({
    account: stored.id,
    name: 'oc-workbench',
    private: true,
    description: '工作台',
  })
  assert.equal(created.repo.fullName, `${gitea.login}/oc-workbench`)
  assert.equal(created.repo.empty, true)
  assert.equal(created.repo.private, true)

  const createCall = gitea.state.calls.filter(
    (call) => call.method === 'POST' && call.path === '/api/v1/user/repos',
  ).at(-1)
  assert.equal(createCall.body.auto_init, false)
  assert.equal(createCall.body.private, true)
  assert.equal(createCall.body.description, '工作台')

  // 重名 → 409，带上游原文
  await assert.rejects(
    () => createRemoteRepo({ account: stored.id, name: 'oc-workbench' }),
    (err) => err.status === 409 && /仓库已存在/.test(err.message) && /already exists/.test(err.message),
  )
})

test('假 Gitea：token 错误 → 401「token 无效或已过期」', async (t) => {
  await tempLocalAppData(t)
  const gitea = await startFakeGitea(t)

  await assert.rejects(
    () => probeRemote({ baseUrl: gitea.baseUrl, token: 'wrong-token', kind: 'gitea' }),
    (err) => {
      assert.equal(err.status, 401)
      assert.match(err.message, /token 无效或已过期/)
      assert.match(err.message, /token is required/)
      return true
    },
  )
})

test('认不出服务类型 → 400；接口不存在 → 404 提示确认是 Gitea', async (t) => {
  await tempLocalAppData(t)

  // 什么都 404：version 探测失败，也不是 github.com
  const baseUrl = await startStubServer(t, (req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'not found' }))
  })
  await assert.rejects(
    () => probeRemote({ baseUrl, token: 'x', kind: '' }),
    (err) => err.status === 400 && /认不出这是 GitHub 还是 Gitea/.test(err.message),
  )

  // 显式 kind=gitea：/user 404 → 契约里的 404 文案
  await assert.rejects(
    () => probeRemote({ baseUrl, token: 'x', kind: 'gitea' }),
    (err) => {
      assert.equal(err.status, 404)
      assert.match(err.message, /接口不存在，确认是 Gitea 而不是别的服务/)
      assert.match(err.message, /not found/)
      return true
    },
  )

  // 账号已存但上游 404：repos 同样给 404 文案
  const saved = await saveAccount({ kind: 'gitea', baseUrl, token: 'x', username: 'alice' })
  await assert.rejects(
    () => listRemoteRepos({ account: saved.account.id }),
    (err) => err.status === 404 && /接口不存在/.test(err.message),
  )
})

test('连不上 → 502 带主机名', async (t) => {
  await tempLocalAppData(t)
  // 拿一个刚关掉的端口：先起再关，端口短期内没人监听
  const baseUrl = await startStubServer(t, (req, res) => res.end('{}'))
  const dead = baseUrl.replace(/:(\d+)$/, ':1')

  await assert.rejects(
    () => probeRemote({ baseUrl: dead, token: 'x', kind: 'gitea' }),
    (err) => err.status === 502 && /连不上/.test(err.message),
  )
})

test('create 的仓库名在本地就拦掉，不打网络', async (t) => {
  await tempLocalAppData(t)
  await assert.rejects(
    () => createRemoteRepo({ account: 'rm-deadbeef', name: 'bad name' }),
    (err) => err.status === 400 && /仓库名只能用字母、数字、点、下划线、短横线/.test(err.message),
  )
})

test('repos/create 引用不存在的账号 → 404', async (t) => {
  await tempLocalAppData(t)
  await assert.rejects(
    () => listRemoteRepos({ account: 'rm-00000000' }),
    (err) => err.status === 404 && /没有这个账号/.test(err.message),
  )
  await assert.rejects(
    () => createRemoteRepo({ account: 'rm-00000000', name: 'ok-name' }),
    (err) => err.status === 404 && /没有这个账号/.test(err.message),
  )
})

// ---------- 账号密码换令牌（login） ----------

test('默认令牌名：本地日期 YYYY-MM-DD', () => {
  assert.equal(defaultTokenName(new Date(2026, 10, 13, 9, 5, 1)), 'oc-workbench-20261113')
  assert.equal(defaultTokenName(new Date(2026, 0, 2)), 'oc-workbench-20260102')
})

test('假 Gitea：正确账号密码 → 拿到令牌、账号被保存、返回值里没有密码', async (t) => {
  await tempLocalAppData(t)
  const gitea = await startFakeGitea(t)

  const result = await remoteApi({
    method: 'POST',
    action: 'login',
    body: {
      baseUrl: gitea.baseUrl,
      username: gitea.login,
      password: gitea.password,
      kind: 'gitea',
      tokenName: '',
    },
  })

  assert.equal(result.kind, 'gitea')
  assert.equal(result.baseUrl, gitea.baseUrl)
  assert.equal(result.apiBase, `${gitea.baseUrl}/api/v1`)
  assert.equal(result.webUrl, gitea.baseUrl)
  assert.equal(result.username, gitea.login)
  assert.equal(result.name, '陆永康')
  assert.equal(result.token, 'generated-token-1')
  assert.equal(result.tokenName, defaultTokenName())
  assert.match(result.tokenName, /^oc-workbench-\d{8}$/)

  // 密码绝不能出现在返回值里：值不行，`password` 这个字段名也不行
  const text = JSON.stringify(result)
  assert.ok(!text.includes(gitea.password), `返回值里出现了密码：${text}`)
  assert.ok(!/password/i.test(text), `返回值里出现了 password 字样：${text}`)

  // 请求体只有 name，不传 scopes（老版本 Gitea 不认这个字段）
  const tokenCall = gitea.state.calls.find((call) => call.path.endsWith('/tokens'))
  assert.ok(tokenCall, '没有请求 /users/{name}/tokens')
  assert.deepEqual(Object.keys(tokenCall.body), ['name'])
  assert.equal(tokenCall.body.name, result.tokenName)

  // 令牌按 /accounts 的规则保存：读接口只回 hasToken，不回 token
  const listed = await listAccounts()
  assert.equal(listed.accounts.length, 1)
  assert.equal(listed.accounts[0].username, gitea.login)
  assert.equal(listed.accounts[0].hasToken, true)
  assertNoToken(listed, result.token)
  const [stored] = await readAccounts()
  assert.equal(stored.token, 'generated-token-1')

  // 新令牌真能用：假桩认它，拿存下来的账号拉仓库
  const repos = await listRemoteRepos({ account: stored.id })
  assert.deepEqual(repos.repos, [])
  assert.ok(
    gitea.state.calls.some((call) => call.method === 'GET' && call.path === '/api/v1/user'),
    'login 应该用新令牌再验一次 /user',
  )
})

test('假 Gitea：密码错 → 401「用户名或密码不对」，错误里不带密码', async (t) => {
  await tempLocalAppData(t)
  const gitea = await startFakeGitea(t)

  await assert.rejects(
    () =>
      loginRemote({
        baseUrl: gitea.baseUrl,
        username: gitea.login,
        password: 'definitely-wrong-pass',
        kind: 'gitea',
      }),
    (err) => {
      assert.equal(err.status, 401)
      assert.match(err.message, /用户名或密码不对/)
      assert.match(err.message, /invalid username, password or token/)
      assert.ok(!err.message.includes('definitely-wrong-pass'), `错误文案泄露了密码：${err.message}`)
      return true
    },
  )

  // 失败不能留下账号
  assert.deepEqual(await listAccounts(), { accounts: [] })

  // 用户名错同样 401，且错误文案里不能出现 Basic 头
  await assert.rejects(
    () =>
      loginRemote({
        baseUrl: gitea.baseUrl,
        username: 'someone-else',
        password: gitea.password,
        kind: 'gitea',
      }),
    (err) => {
      assert.equal(err.status, 401)
      assert.match(err.message, /用户名或密码不对/)
      assert.ok(!err.message.includes('Basic '), `错误文案泄露了认证头：${err.message}`)
      return true
    },
  )
})

test('GitHub 不支持账号密码登录 → 400', async (t) => {
  await tempLocalAppData(t)

  await assert.rejects(
    () => loginRemote({ baseUrl: 'https://github.com', username: 'octocat', password: 'x', kind: 'github' }),
    (err) => err.status === 400 && /GitHub 不支持账号密码登录，请用令牌/.test(err.message),
  )

  // kind 留空时按 §2 探测，github.com 同样落到这条分支
  await assert.rejects(
    () => loginRemote({ baseUrl: 'https://github.com', username: 'octocat', password: 'x', kind: '' }),
    (err) => err.status === 400 && /GitHub 不支持账号密码登录/.test(err.message),
  )

  assert.deepEqual(await listAccounts(), { accounts: [] })
})

test('login 参数校验与「接口不存在」文案', async (t) => {
  await tempLocalAppData(t)

  await assert.rejects(
    () => loginRemote({ baseUrl: 'http://h:3000', username: '  ', password: 'x', kind: 'gitea' }),
    (err) => err.status === 400 && /请填 Gitea 用户名/.test(err.message),
  )
  await assert.rejects(
    () => loginRemote({ baseUrl: 'http://h:3000', username: 'a', password: '', kind: 'gitea' }),
    (err) => err.status === 400 && /请填密码/.test(err.message),
  )
  await assert.rejects(
    () => loginRemote({ username: 'a', password: 'x', kind: 'gitea' }),
    (err) => err.status === 400 && /缺少服务器地址/.test(err.message),
  )

  // 老版本 Gitea 没有建令牌接口 → 专用文案，别让用户去猜
  const baseUrl = await startStubServer(t, (req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'not found' }))
  })
  await assert.rejects(
    () => loginRemote({ baseUrl, username: 'a', password: 'x', kind: 'gitea' }),
    (err) => err.status === 404 && /这个 Gitea 版本不支持用接口创建令牌，请改用令牌方式/.test(err.message),
  )
})

// ---------- open-url ----------

test('open-url 协议白名单：javascript / file / data 全拒，https 通过', () => {
  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<h1>x</h1>',
    'vbscript:msgbox(1)',
    'not a url',
    '',
    '   ',
  ]) {
    assert.throws(() => assertOpenableUrl(bad), (err) => err.status === 400, `应拒绝：${bad}`)
  }

  // 长度上限 2048
  assert.ok(assertOpenableUrl(`https://github.com/${'a'.repeat(2000)}`).length > 0)
  assert.throws(() => assertOpenableUrl(`https://github.com/${'a'.repeat(2100)}`), (err) => err.status === 400)

  const url =
    'https://github.com/settings/tokens/new?scopes=repo&description=OpenCode%20%E5%B7%A5%E4%BD%9C%E5%8F%B0'
  assert.equal(assertOpenableUrl(`  ${url}  `), url)
})

test('open-url：Windows 用 cmd + verbatim 参数，URL 自带引号（& 不被 cmd 吃掉）', () => {
  const url = 'https://github.com/settings/tokens/new?scopes=repo&description=oc'

  const win = buildOpenCommand(url, 'win32')
  assert.equal(win.command, 'cmd')
  assert.equal(win.verbatim, true)
  // /c start "" "<url>" —— 空标题占位必须在
  assert.deepEqual(win.args.slice(0, 3), ['/c', 'start', '""'])
  assert.ok(win.args[3].startsWith('"') && win.args[3].endsWith('"'), 'URL 必须自带引号')
  assert.ok(win.args[3].includes(url), '完整 URL 要原样传下去')

  assert.deepEqual(buildOpenCommand(url, 'darwin'), { command: 'open', args: [url], verbatim: false })
  assert.deepEqual(buildOpenCommand(url, 'linux'), { command: 'xdg-open', args: [url], verbatim: false })
})

test('open-url：通过校验才拉起浏览器（spawn 打桩，不真开浏览器）', async () => {
  const calls = []
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.unref = () => {}
    setImmediate(() => child.emit('spawn'))
    return child
  }

  // 被拦下的协议一步都不该走到 spawn
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd']) {
    await assert.rejects(
      () => openRemoteUrl({ url: bad }, { spawnFn: fakeSpawn }),
      (err) => err.status === 400,
    )
    // 走路由也一样，且不会因为「参数没传」变成 500
    await assert.rejects(
      () => remoteApi({ method: 'POST', action: 'open-url', body: { url: bad } }),
      (err) => err.status === 400,
    )
    await assert.rejects(
      () => remoteApi({ method: 'POST', action: 'openUrl', body: { url: bad } }),
      (err) => err.status === 400,
    )
  }
  assert.equal(calls.length, 0, '被拒的地址不该拉起任何进程')

  const url =
    'https://github.com/settings/tokens/new?scopes=repo&description=OpenCode%20%E5%B7%A5%E4%BD%9C%E5%8F%B0'
  assert.deepEqual(await openRemoteUrl({ url }, { spawnFn: fakeSpawn }), { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.windowsHide, true)
  // 不管在哪个平台跑测试，URL 都必须原样出现在参数里
  assert.ok(calls[0].args.some((arg) => arg.includes(url)), `参数里没有完整 URL：${calls[0].args}`)
})

test('open-url：spawn 失败 → 500「打开浏览器失败」', async () => {
  const failingSpawn = () => {
    const child = new EventEmitter()
    child.unref = () => {}
    setImmediate(() => child.emit('error', new Error('ENOENT cmd')))
    return child
  }

  await assert.rejects(
    () => openRemoteUrl({ url: 'https://github.com' }, { spawnFn: failingSpawn }),
    (err) => err.status === 500 && /打开浏览器失败/.test(err.message),
  )
})
