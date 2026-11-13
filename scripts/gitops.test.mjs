// Git 面板 dev 后端（scripts/dev-local-git.mjs）的回归。
//
// 分两层：
//   1. 纯函数（porcelain 解析 / 分支头 / 日志 / .gitignore 规则 / 远程地址校验）—— 不碰磁盘；
//   2. 真仓库端到端 —— 在 os.tmpdir() 下建临时目录，真的跑 git，直接调内部 `gitApi`，
//      不起 HTTP server（中间件只是把请求翻译成 gitApi 的参数）。
//
// 覆盖契约里的关键行为：未初始化不报错、init 写基础 .gitignore、untracked、
// 提交后干净 + 历史、排除已跟踪目录（必须 git rm --cached）、soft 回滚保留改动。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  buildIgnoreRule,
  gitApi,
  isValidRemoteUrl,
  parseBranchHeader,
  parseBranches,
  parseGitignore,
  parseLogGraph,
  parseLogZ,
  parsePorcelain,
} from './dev-local-git.mjs'

const execFileAsync = promisify(execFile)

/** 裸 git 调用（测数据准备用，与被测实现互不依赖）。 */
async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout
}

/** 每个用例自己的临时目录，结束就整棵删掉。 */
async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocwb-git-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  return dir
}

/** 直接 git init（不写 .gitignore），这样提交涉及的文件数可预期。 */
async function initRepoAt(dir) {
  await git(dir, ['init', '-b', 'main'])
  // 临时仓库不依赖机器上的全局身份
  await git(dir, ['config', 'user.name', '测试用户'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  // Git for Windows 默认 autocrlf=true，检出会把 \n 换成 \r\n；
  // 固定成 false 才能逐字节断言「撤销后内容回到原样」
  await git(dir, ['config', 'core.autocrlf', 'false'])
  return dir
}

async function makeRepo(t) {
  return initRepoAt(await tempDir(t))
}

/** 断言一个 promise 按 `{ status, message }` 失败。 */
async function rejectsWith(promise, status, hint) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, status, `${hint}（实际消息：${err.message}）`)
    return true
  })
}

// ---------------- 纯函数 ----------------

test('parseBranchHeader：无上游 / 有上游 / 未出生 / 分离 HEAD', () => {
  assert.deepEqual(parseBranchHeader('## main'), {
    branch: 'main',
    upstream: '',
    ahead: 0,
    behind: 0,
    detached: false,
    noUpstream: true,
  })

  const tracked = parseBranchHeader('## main...origin/main [ahead 2, behind 1]')
  assert.equal(tracked.branch, 'main')
  assert.equal(tracked.upstream, 'origin/main')
  assert.equal(tracked.ahead, 2)
  assert.equal(tracked.behind, 1)
  assert.equal(tracked.noUpstream, false)

  const fresh = parseBranchHeader('## No commits yet on main')
  assert.equal(fresh.branch, 'main')
  assert.equal(fresh.upstream, '')
  assert.equal(fresh.noUpstream, true)

  const detached = parseBranchHeader('## HEAD (no branch)')
  assert.equal(detached.detached, true)
  assert.equal(detached.branch, '')

  // 上游分支被删了（[gone]）当作没有上游，别让前端显示不存在的跟踪目标
  const gone = parseBranchHeader('## main...origin/main [gone]')
  assert.equal(gone.upstream, '')
  assert.equal(gone.noUpstream, true)
})

test('parsePorcelain：untracked / 暂存且工作区又改 / 重命名 / 冲突', () => {
  const raw =
    '## main...origin/main [ahead 1]\x00' +
    '?? 新文件.txt\x00' +
    'MM src/a.ts\x00' +
    'R  new.ts\x00old.ts\x00' +
    'UU conflict.ts\x00' +
    'A  staged-new.ts\x00'
  const { header, files } = parsePorcelain(raw)

  assert.equal(header, '## main...origin/main [ahead 1]')
  assert.deepEqual(files, [
    { path: '新文件.txt', status: 'untracked', staged: false, worktreeDirty: false },
    { path: 'src\\a.ts', status: 'modified', staged: true, worktreeDirty: true },
    { path: 'new.ts', status: 'renamed', staged: true, worktreeDirty: false, renamedFrom: 'old.ts' },
    { path: 'conflict.ts', status: 'conflicted', staged: true, worktreeDirty: true },
    { path: 'staged-new.ts', status: 'added', staged: true, worktreeDirty: false },
  ])
})

test('parseLogZ：HEAD 标记、tag 提取、字段拆分', () => {
  // 注意分隔符写 \x00：`\0` 后面紧跟数字时会被 JS 当成八进制转义
  const raw =
    'aaaa\x00aaaa123\x00第一条\x00张三\x001700000000\x00HEAD -> main, tag: v1\x00\n' +
    'bbbb\x00bbbb123\x00第二条\x00李四\x001700000001\x00origin/main\x00\n'
  const commits = parseLogZ(raw)

  assert.equal(commits.length, 2)
  assert.deepEqual(commits[0], {
    hash: 'aaaa',
    short: 'aaaa123',
    message: '第一条',
    author: '张三',
    time: 1700000000,
    isHead: true,
    tags: ['v1'],
  })
  assert.equal(commits[1].isHead, false)
  assert.deepEqual(commits[1].tags, [])
  assert.deepEqual(parseLogZ(''), [])
})

test('parseLogGraph：%P 拆父提交、%D 多 ref 全保留、空父提交是 []', () => {
  const raw =
    'aaa\x00aaa111\x00bbb ccc\x00merge it\x00张三\x001700000000\x00HEAD -> main, origin/main, tag: v0.2\x00\n' +
    'bbb\x00bbb111\x00\x00root\x00李四\x001700000001\x00\x00\n'
  const commits = parseLogGraph(raw)

  assert.equal(commits.length, 2)
  // 合并提交：两个父，顺序不动；refs 保留原始形态（tag: 前缀不剥），tags 只给名字
  assert.deepEqual(commits[0].parents, ['bbb', 'ccc'])
  assert.deepEqual(commits[0].refs, ['HEAD -> main', 'origin/main', 'tag: v0.2'])
  assert.deepEqual(commits[0].tags, ['v0.2'])
  assert.equal(commits[0].isHead, true)
  // 根提交：%P 为空串，不能变成 ['']；没有装饰时 refs/tags 都是空数组
  assert.deepEqual(commits[1].parents, [])
  assert.deepEqual(commits[1].refs, [])
  assert.deepEqual(commits[1].tags, [])
  assert.equal(commits[1].isHead, false)
  assert.deepEqual(parseLogGraph(''), [])
})

test('parseBranches：local / remote / tag 分类，跳过 origin/HEAD 符号引用', () => {
  const raw =
    // 注意 origin/HEAD 的 %(refname:short) 只给 `origin`，只能靠完整 refname 认出来
    'main\0aaa\0refs/heads/main\n' +
    'origin\0aaa\0refs/remotes/origin/HEAD\n' +
    'origin/main\0bbb\0refs/remotes/origin/main\n' +
    'v0.2\0ccc\0refs/tags/v0.2\n'
  assert.deepEqual(parseBranches(raw), [
    { name: 'main', kind: 'local', hash: 'aaa' },
    { name: 'origin/main', kind: 'remote', hash: 'bbb' },
    { name: 'v0.2', kind: 'tag', hash: 'ccc' },
  ])
  assert.deepEqual(parseBranches(''), [])
})

test('buildIgnoreRule：目录补斜杠，反斜杠必须转成正斜杠', () => {
  assert.equal(buildIgnoreRule('node_modules', true), 'node_modules/')
  assert.equal(buildIgnoreRule('node_modules/', false), 'node_modules')
  // gitignore 里反斜杠是转义符，写 src\a.ts 会匹配不到任何东西
  assert.equal(buildIgnoreRule('src\\secret.ts', false), 'src/secret.ts')
  assert.equal(buildIgnoreRule('/dist/', true), 'dist/')
  assert.equal(buildIgnoreRule('', true), '')
})

test('parseGitignore：丢掉空行和注释，保留结尾斜杠', () => {
  assert.deepEqual(parseGitignore('# 注释\n\nnode_modules/\n  \n*.log\n')  , ['node_modules/', '*.log'])
})

test('isValidRemoteUrl：认几种正常形态，拒掉乱写的', () => {
  for (const url of [
    'https://github.com/me/repo.git',
    'http://127.0.0.1:3000/me/repo.git',
    'git@github.com:me/repo.git',
    'ssh://git@host/me/repo.git',
    'file:///tmp/repo.git',
    'D:\\repos\\repo.git',
    // 本地路径里带空格/中文是合法的（Windows 盘符路径照收）
    'D:\\repos\\带 空格\\repo.git',
    '/home/me/repo.git',
    '\\\\nas\\share\\repo.git',
  ]) {
    assert.equal(isValidRemoteUrl(url), true, url)
  }
  for (const url of [
    '',
    '随便写点什么',
    'https://',
    'git@host',
    'git@host:',
    'ftp://x/y',
    // 远端形态不允许空格
    'https://github.com/me/repo with space.git',
  ]) {
    assert.equal(isValidRemoteUrl(url), false, url)
  }
})

// ---------------- 真仓库端到端 ----------------

test('未初始化的目录：status 返回 initialized:false，不报错', async (t) => {
  const dir = await tempDir(t)
  await writeFile(path.join(dir, 'a.ts'), 'export const a = 1\n')

  const status = await gitApi({ action: 'status', root: dir })
  assert.deepEqual(status, {
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
  })
})

test('init：建仓库 + 写基础 .gitignore，重复调用返回 alreadyInitialized', async (t) => {
  const dir = await tempDir(t)

  const first = await gitApi({ method: 'POST', action: 'init', root: dir })
  assert.deepEqual(first, { ok: true, branch: 'main', alreadyInitialized: false })

  const ignore = await readFile(path.join(dir, '.gitignore'), 'utf8')
  assert.deepEqual(parseGitignore(ignore), [
    'node_modules/',
    'dist/',
    '.tmp/',
    '*.log',
    '.DS_Store',
    'target/',
    '.vite/',
  ])
  assert.equal(ignore.endsWith('\n'), true)

  // 已有的 .gitignore 是用户的，不能被覆盖
  await writeFile(path.join(dir, '.gitignore'), 'custom/\n', 'utf8')
  const second = await gitApi({ method: 'POST', action: 'init', root: dir })
  assert.equal(second.alreadyInitialized, true)
  assert.equal(second.branch, 'main')
  assert.equal(await readFile(path.join(dir, '.gitignore'), 'utf8'), 'custom/\n')

  // 初始化完 status 立刻可用
  assert.equal((await gitApi({ action: 'status', root: dir })).initialized, true)
})

test('新建文件后 status 是 untracked，中文文件名不被转义', async (t) => {
  const dir = await makeRepo(t)
  await mkdir(path.join(dir, 'src'))
  await writeFile(path.join(dir, 'src', 'a.ts'), 'export const a = 1\n')
  await writeFile(path.join(dir, '中文文件.txt'), '你好\n')

  const status = await gitApi({ action: 'status', root: dir })
  assert.equal(status.initialized, true)
  assert.equal(status.branch, 'main')
  assert.equal(status.detached, false)

  const byPath = new Map(status.files.map((file) => [file.path, file]))
  assert.deepEqual(byPath.get('src\\a.ts'), {
    path: 'src\\a.ts',
    status: 'untracked',
    staged: false,
    worktreeDirty: false,
  })
  // 没带 core.quotepath=false 的话这里会是 \344\270\255\346\226\207...
  assert.ok(byPath.has('中文文件.txt'), `中文文件名应原样返回，实际：${[...byPath.keys()].join(',')}`)
  assert.equal(byPath.get('中文文件.txt').status, 'untracked')
})

test('仓库路径带空格和中文：状态 / 提交都不受影响', async (t) => {
  const base = await tempDir(t)
  const dir = path.join(base, '工作 区', '项目')
  await mkdir(dir, { recursive: true })
  await initRepoAt(dir)

  await writeFile(path.join(dir, '中文 文件.txt'), '内容\n')
  const status = await gitApi({ action: 'status', root: dir })
  assert.deepEqual(status.files, [
    { path: '中文 文件.txt', status: 'untracked', staged: false, worktreeDirty: false },
  ])

  const commit = await gitApi({ method: 'POST', action: 'commit', root: dir, body: { message: '带空格' } })
  assert.equal(commit.ok, true)
  assert.equal(commit.count, 1)
  assert.deepEqual((await gitApi({ action: 'status', root: dir })).files, [])
})

test('commit 后 status 干净、log 有一条并标为 HEAD', async (t) => {
  const dir = await makeRepo(t)
  await writeFile(path.join(dir, 'a.txt'), 'a\n')

  const commit = await gitApi({
    method: 'POST',
    action: 'commit',
    root: dir,
    // 前后空白要 trim 掉
    body: { message: '  第一次提交  ', paths: [] },
  })
  assert.equal(commit.ok, true)
  assert.equal(commit.hash.length, 40)
  assert.equal(commit.short, commit.hash.slice(0, 7))
  assert.equal(commit.count, 1)

  const status = await gitApi({ action: 'status', root: dir })
  assert.deepEqual(status.files, [])
  assert.equal(status.lastCommit.hash, commit.hash)
  assert.equal(status.lastCommit.message, '第一次提交')
  assert.equal(status.noUpstream, true)

  const log = await gitApi({ action: 'log', root: dir })
  assert.equal(log.commits.length, 1)
  assert.equal(log.commits[0].hash, commit.hash)
  assert.equal(log.commits[0].message, '第一次提交')
  assert.equal(log.commits[0].isHead, true)
  assert.deepEqual(log.commits[0].tags, [])

  // 没改动不能再提交：409，不要放给 git 报英文
  await rejectsWith(
    gitApi({ method: 'POST', action: 'commit', root: dir, body: { message: '空提交' } }),
    409,
    '无改动应回 409',
  )
  // 说明为空是 400
  await rejectsWith(
    gitApi({ method: 'POST', action: 'commit', root: dir, body: { message: '   ' } }),
    400,
    '空说明应回 400',
  )
})

test('空仓库 log 返回空数组（不是报错）', async (t) => {
  const dir = await makeRepo(t)
  // 契约 §1：空仓库同样给全四个字段，head 为空、detached:false
  assert.deepEqual(await gitApi({ action: 'log', root: dir }), {
    commits: [],
    branches: [],
    head: '',
    detached: false,
  })
  assert.equal((await gitApi({ action: 'status', root: dir })).lastCommit, null)
})

test('ignore 加目录规则后 tree 里该目录 ignored:true，remove 能删掉', async (t) => {
  const dir = await makeRepo(t)
  await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), '//\n')
  await writeFile(path.join(dir, 'app.ts'), '1\n')

  const added = await gitApi({
    method: 'POST',
    action: 'ignore',
    root: dir,
    // 结尾反斜杠也应该认成目录
    body: { paths: ['node_modules\\'], action: 'add' },
  })
  assert.equal(added.ok, true)
  assert.deepEqual(added.gitignore, ['node_modules/'])

  const tree = await gitApi({ action: 'tree', root: dir })
  const npm = tree.entries.find((entry) => entry.name === 'node_modules')
  assert.ok(npm, 'node_modules 应该出现在树里')
  assert.equal(npm.type, 'directory')
  assert.equal(npm.ignored, true)
  assert.equal(npm.path, 'node_modules')

  const app = tree.entries.find((entry) => entry.name === 'app.ts')
  assert.equal(app.type, 'file')
  assert.equal(app.ignored, false)

  // .git 不出现；目录排在最前（与 /local/fs/list 一致）
  assert.equal(tree.entries.some((entry) => entry.name === '.git'), false)
  assert.equal(tree.entries[0].type, 'directory')

  // 重目录不往下展开
  assert.deepEqual((await gitApi({ action: 'tree', root: dir, relPath: 'node_modules' })).entries, [])

  const removed = await gitApi({
    method: 'POST',
    action: 'ignore',
    root: dir,
    body: { paths: ['node_modules'], action: 'remove' },
  })
  assert.deepEqual(removed.gitignore, [])
  const after = await gitApi({ action: 'status', root: dir })
  assert.equal(after.gitignore.length, 0)
})

test('rollback soft：历史回到目标提交，工作区改动保留', async (t) => {
  const dir = await makeRepo(t)
  await writeFile(path.join(dir, 'a.txt'), 'v1\n')
  const first = await gitApi({ method: 'POST', action: 'commit', root: dir, body: { message: '第一版' } })

  await writeFile(path.join(dir, 'a.txt'), 'v2\n')
  await writeFile(path.join(dir, 'b.txt'), 'b\n')
  const second = await gitApi({ method: 'POST', action: 'commit', root: dir, body: { message: '第二版' } })
  assert.equal(second.count, 2)
  assert.equal((await gitApi({ action: 'log', root: dir })).commits.length, 2)

  const rolled = await gitApi({
    method: 'POST',
    action: 'rollback',
    root: dir,
    // 用短 hash 也要能解析；回滚到「第一版」才是真的在回滚
    body: { hash: first.short, mode: 'soft' },
  })
  assert.equal(rolled.ok, true)
  assert.equal(rolled.mode, 'soft')
  assert.equal(rolled.branch, 'main')

  const log = await gitApi({ action: 'log', root: dir })
  assert.equal(log.commits.length, 1)
  assert.equal(log.commits[0].hash, first.hash)

  // soft：磁盘上的内容一个字节都没少
  assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'v2\n')
  assert.equal(await readFile(path.join(dir, 'b.txt'), 'utf8'), 'b\n')
  const status = await gitApi({ action: 'status', root: dir })
  assert.equal(status.files.length, 2, 'soft 回滚后改动应该还在（进暂存区）')
  assert.ok(status.files.every((file) => file.staged === true))

  // 找不到的提交是 400，不是 500
  await rejectsWith(
    gitApi({ method: 'POST', action: 'rollback', root: dir, body: { hash: 'deadbeef' } }),
    400,
    '不存在的提交应回 400',
  )
  // 只认 soft / hard
  await rejectsWith(
    gitApi({ method: 'POST', action: 'rollback', root: dir, body: { hash: first.short, mode: 'mixed' } }),
    400,
    '未知模式应回 400',
  )
})

test('端到端：init → 提交 → 排除已跟踪目录 → 撤销改动 → 设置远程', async (t) => {
  const dir = await tempDir(t)
  await gitApi({ method: 'POST', action: 'init', root: dir })
  // 与 initRepoAt 一致：关掉 autocrlf，撤销后才能逐字节比对
  await git(dir, ['config', 'core.autocrlf', 'false'])

  await writeFile(path.join(dir, 'keep.txt'), 'v1\n')
  await mkdir(path.join(dir, 'logs'))
  await writeFile(path.join(dir, 'logs', 'run.txt'), 'line\n')

  // .gitignore 是 init 刚写的，一起进这次提交
  const first = await gitApi({ method: 'POST', action: 'commit', root: dir, body: { message: '首次提交' } })
  assert.equal(first.count, 3)

  // 已跟踪的目录加排除：必须顺带 git rm -r --cached，否则规则不生效
  const ignored = await gitApi({
    method: 'POST',
    action: 'ignore',
    root: dir,
    body: { paths: ['logs'], action: 'add' },
  })
  assert.ok(ignored.gitignore.includes('logs/'))
  const tracked = (await git(dir, ['ls-files'])).split('\n').filter(Boolean).sort()
  assert.deepEqual(tracked, ['.gitignore', 'keep.txt'])
  // `git rm --cached` 会留下一条「已暂存的删除」等提交（这就是它生效的证据）；
  // logs/ 规则写进 .gitignore 后，文件不再以 untracked 出现
  const statusAfterIgnore = await gitApi({ action: 'status', root: dir })
  assert.deepEqual(statusAfterIgnore.files, [
    { path: '.gitignore', status: 'modified', staged: false, worktreeDirty: false },
    { path: 'logs\\run.txt', status: 'deleted', staged: true, worktreeDirty: false },
  ])

  // 提交掉这次删除，仓库回到干净
  await gitApi({ method: 'POST', action: 'commit', root: dir, body: { message: '排除 logs' } })
  assert.deepEqual((await gitApi({ action: 'status', root: dir })).files, [])

  // discard：跟踪文件回到 HEAD 内容，未跟踪文件直接删
  await writeFile(path.join(dir, 'keep.txt'), 'dirty\n')
  await writeFile(path.join(dir, 'new.txt'), 'new\n')
  const discarded = await gitApi({
    method: 'POST',
    action: 'discard',
    root: dir,
    body: { paths: ['keep.txt', 'new.txt'] },
  })
  assert.deepEqual(discarded, { ok: true, count: 2 })
  assert.equal(await readFile(path.join(dir, 'keep.txt'), 'utf8'), 'v1\n')
  await assert.rejects(() => stat(path.join(dir, 'new.txt')), /ENOENT/)

  // 远程：非法形态 400
  await rejectsWith(
    gitApi({ method: 'POST', action: 'remote', root: dir, body: { url: '随便写点什么' } }),
    400,
    '非法远程地址应回 400',
  )

  // 用本地裸库当远端：离线、确定，还能顺带验证 push 成功路径与上游跟踪
  const bareParent = await tempDir(t)
  await git(bareParent, ['init', '--bare', '裸 库.git'])
  const bare = path.join(bareParent, '裸 库.git')

  const remote = await gitApi({ method: 'POST', action: 'remote', root: dir, body: { url: bare } })
  assert.deepEqual(remote, { ok: true, remote: bare })
  const statusWithRemote = await gitApi({ action: 'status', root: dir })
  assert.equal(statusWithRemote.remote, bare)
  assert.equal(statusWithRemote.noUpstream, true)

  const pushed = await gitApi({ method: 'POST', action: 'push', root: dir, body: {} })
  assert.equal(pushed.ok, true)
  assert.equal(pushed.branch, 'main')
  assert.equal(typeof pushed.output, 'string')
  // 远端真的收到了提交
  assert.equal((await git(bare, ['log', '-1', '--format=%s'])).trim(), '排除 logs')

  // 推完就有上游了，ahead/behind 归零
  const trackedStatus = await gitApi({ action: 'status', root: dir })
  assert.equal(trackedStatus.upstream, 'origin/main')
  assert.equal(trackedStatus.ahead, 0)
  assert.equal(trackedStatus.behind, 0)
  assert.equal(trackedStatus.noUpstream, undefined)

  // 空串 → 删除 origin
  assert.deepEqual(
    await gitApi({ method: 'POST', action: 'remote', root: dir, body: { url: '' } }),
    { ok: true, remote: '' },
  )
  assert.equal((await gitApi({ action: 'status', root: dir })).remote, '')
})

test('push 失败：没有 origin 回 400，远端不可达回 502 并带 git 原文', async (t) => {
  const dir = await makeRepo(t)
  await writeFile(path.join(dir, 'a.txt'), 'a\n')
  await gitApi({ method: 'POST', action: 'commit', root: dir, body: { message: '提交' } })

  await rejectsWith(
    gitApi({ method: 'POST', action: 'push', root: dir, body: {} }),
    400,
    '没有 origin 应回 400',
  )

  // 指向一个不存在的本地路径：git 会立刻失败，不会碰网络
  const missing = path.join(await tempDir(t), '没有这个库.git')
  await gitApi({ method: 'POST', action: 'remote', root: dir, body: { url: missing } })
  const failure = await gitApi({ method: 'POST', action: 'push', root: dir, body: {} }).then(
    () => null,
    (err) => err,
  )
  assert.ok(failure, '应当推送失败')
  assert.equal(failure.status, 502)
  // 契约要求把 git 的 stderr 原文透出来，不能换成自己的话
  assert.match(failure.message, /does not appear to be a git repository|repository .* does not exist/i)
})

test('方法 / 路由防护：GET 接口拒绝 POST，未定义的动作 404', async (t) => {
  const dir = await tempDir(t)
  await rejectsWith(gitApi({ method: 'POST', action: 'status', root: dir }), 405, 'status 只支持 GET')
  await rejectsWith(gitApi({ method: 'GET', action: 'commit', root: dir }), 405, 'commit 只支持 POST')
  // 契约明确不做分支/合并这类操作，路由里也不能有
  await rejectsWith(gitApi({ action: 'merge', root: dir }), 404, '未定义动作应回 404')
  await rejectsWith(gitApi({ action: 'branch', root: dir }), 404, '未定义动作应回 404')
})

// ---------------- 图形树的真仓库场景 ----------------

/** 造「root(+tag v0.1) → 分叉 feature / main → 合并」的仓库。 */
async function makeMergeRepo(t) {
  const dir = await makeRepo(t)

  await writeFile(path.join(dir, 'root.txt'), 'root\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-m', 'root commit'])
  const root = (await git(dir, ['rev-parse', 'HEAD'])).trim()
  await git(dir, ['tag', 'v0.1'])

  await git(dir, ['checkout', '-q', '-b', 'feature'])
  await writeFile(path.join(dir, 'feature.txt'), 'f\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-m', 'feature one'])
  const featureTip = (await git(dir, ['rev-parse', 'HEAD'])).trim()

  await git(dir, ['checkout', '-q', 'main'])
  await writeFile(path.join(dir, 'main.txt'), 'm\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-m', 'main two'])

  await git(dir, ['merge', '--no-ff', '-m', 'merge feature', 'feature'])
  const merge = (await git(dir, ['rev-parse', 'HEAD'])).trim()

  return { dir, root, featureTip, merge }
}

test('log：双分支 + 合并 → parents 两条、branches 分类、head 正确、无远程全未推送', async (t) => {
  const { dir, root, featureTip, merge } = await makeMergeRepo(t)

  const log = await gitApi({ action: 'log', root: dir })
  assert.equal(log.head, 'main')
  assert.equal(log.detached, false)
  // --all 把两条分支的提交都拉进来
  assert.equal(log.commits.length, 4, `应看到 4 个提交：${JSON.stringify(log.commits.map((c) => c.message))}`)

  const byHash = new Map(log.commits.map((commit) => [commit.hash, commit]))
  const merged = byHash.get(merge)
  assert.equal(merged.parents.length, 2, '合并提交必须有两个父')
  assert.equal(merged.message, 'merge feature')
  assert.equal(merged.isHead, true)
  assert.ok(merged.refs.includes('HEAD -> main'), `refs 应保留 HEAD -> main：${merged.refs}`)

  // 根提交：%P 空串 → []
  assert.deepEqual(byHash.get(root).parents, [])
  // 标签同时进 refs（原样）和 tags（去前缀）
  assert.ok(byHash.get(root).refs.includes('tag: v0.1'))
  assert.deepEqual(byHash.get(root).tags, ['v0.1'])
  // feature 分支尖端的装饰
  assert.ok(byHash.get(featureTip).refs.includes('feature'))

  // branches：两个本地分支 + 一个标签，没有远程
  const locals = log.branches
    .filter((branch) => branch.kind === 'local')
    .map((branch) => branch.name)
    .sort()
  assert.deepEqual(locals, ['feature', 'main'])
  assert.deepEqual(log.branches.filter((branch) => branch.kind === 'remote'), [])
  assert.deepEqual(log.branches.filter((branch) => branch.kind === 'tag'), [
    { name: 'v0.1', kind: 'tag', hash: root },
  ])

  // 没有远程 → 契约要求全部标成未推送
  assert.ok(log.commits.every((commit) => commit.unpushed === true), '没有远程时所有提交都应未推送')

  // 分离 HEAD：head 空串 + detached:true，且裸 `HEAD` 段不能进 refs
  await git(dir, ['checkout', '-q', '--detach', 'main'])
  const detached = await gitApi({ action: 'log', root: dir })
  assert.equal(detached.head, '')
  assert.equal(detached.detached, true)
  const detachedTip = detached.commits.find((commit) => commit.hash === merge)
  assert.equal(detachedTip.isHead, true)
  assert.ok(!detachedTip.refs.includes('HEAD'), `refs 不应含裸 HEAD：${detachedTip.refs}`)
})

test('log：远程已推送 false / 本地领先 true，origin/HEAD 不进 branches', async (t) => {
  const { dir } = await makeMergeRepo(t)

  const bareParent = await tempDir(t)
  await git(bareParent, ['init', '--bare', 'remote.git'])
  const bare = path.join(bareParent, 'remote.git')
  await git(dir, ['remote', 'add', 'origin', bare])
  await git(dir, ['push', '-q', '-u', 'origin', 'main'])
  // 模拟 clone 出来的符号引用：refs/remotes/origin/HEAD → origin/main
  await git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])

  // 推完再造一个本地提交
  await writeFile(path.join(dir, 'later.txt'), 'later\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-m', 'later local'])
  const later = (await git(dir, ['rev-parse', 'HEAD'])).trim()

  const log = await gitApi({ action: 'log', root: dir })
  const byHash = new Map(log.commits.map((commit) => [commit.hash, commit]))

  assert.equal(byHash.get(later).unpushed, true, '本地新提交应标未推送')
  // 合并提交已经在 origin/main 上（feature 的提交也随合并一起推上去了）
  assert.equal(byHash.get(log.commits.find((c) => c.message === 'merge feature').hash).unpushed, false)
  assert.equal(byHash.get(log.commits.find((c) => c.message === 'feature one').hash).unpushed, false)

  // origin/HEAD 只是符号引用，不能变成一条远程分支
  assert.deepEqual(
    log.branches.filter((branch) => branch.kind === 'remote').map((branch) => branch.name),
    ['origin/main'],
  )
  assert.ok(log.branches.some((branch) => branch.kind === 'tag' && branch.name === 'v0.1'))
  assert.ok(log.branches.some((branch) => branch.kind === 'local' && branch.name === 'main'))
})
