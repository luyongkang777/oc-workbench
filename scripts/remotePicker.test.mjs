// 远程仓库选择相关的纯函数回归测试：
// node --experimental-strip-types --test scripts/remotePicker.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  accountLabel,
  defaultRepoName,
  sortRepos,
} from '../src/components/git/gitFormat.ts'

function repo(over) {
  return {
    fullName: 'owner/name',
    name: 'name',
    owner: 'owner',
    private: false,
    cloneUrl: 'https://example.com/owner/name.git',
    sshUrl: 'git@example.com:owner/name.git',
    defaultBranch: 'main',
    updatedAt: 0,
    empty: false,
    ...over,
  }
}

function account(over) {
  return {
    id: 'rm-00000001',
    kind: 'gitea',
    baseUrl: 'http://192.168.31.8:3000',
    webUrl: 'http://192.168.31.8:3000',
    username: 'luyongkang777',
    hasToken: true,
    createdAt: 0,
    ...over,
  }
}

/* ---------- defaultRepoName ---------- */

test('defaultRepoName: Windows 路径取最后一段并小写', () => {
  assert.equal(defaultRepoName('F:\\opencode\\workbench'), 'workbench')
  assert.equal(defaultRepoName('F:\\opencode\\MyProject'), 'myproject')
})

test('defaultRepoName: POSIX 路径同样处理', () => {
  assert.equal(defaultRepoName('/f/opencode/workbench'), 'workbench')
  assert.equal(defaultRepoName('/home/me/Some_Repo.v2'), 'some_repo.v2')
})

test('defaultRepoName: 结尾分隔符不算最后一段', () => {
  assert.equal(defaultRepoName('F:\\opencode\\workbench\\'), 'workbench')
  assert.equal(defaultRepoName('/a/b///'), 'b')
})

test('defaultRepoName: 非法字符换 -，连续 - 合并，去首尾 -', () => {
  assert.equal(defaultRepoName('My Project (v2)'), 'my-project-v2')
  assert.equal(defaultRepoName('a---b'), 'a-b')
  assert.equal(defaultRepoName('-lead-trail-'), 'lead-trail')
  assert.equal(defaultRepoName('工作区'), 'repo')
})

test('defaultRepoName: 空串 / 全分隔符 / 全非法字符都退回 repo', () => {
  assert.equal(defaultRepoName(''), 'repo')
  assert.equal(defaultRepoName('   '), 'repo')
  assert.equal(defaultRepoName('///'), 'repo')
  assert.equal(defaultRepoName('★★★'), 'repo')
})

test('defaultRepoName: 盘符根没有目录名，退回 repo', () => {
  assert.equal(defaultRepoName('C:\\'), 'repo')
  assert.equal(defaultRepoName('D:/'), 'repo')
})

test('defaultRepoName: 合法字符原样保留', () => {
  assert.equal(defaultRepoName('ok.name_1-2'), 'ok.name_1-2')
})

/* ---------- sortRepos ---------- */

test('sortRepos: 空数组', () => {
  assert.deepEqual(sortRepos([]), [])
})

test('sortRepos: 空仓库优先，组内按 updatedAt 倒序', () => {
  const a = repo({ fullName: 'a/a', updatedAt: 100, empty: false })
  const b = repo({ fullName: 'b/b', updatedAt: 1, empty: true })
  const c = repo({ fullName: 'c/c', updatedAt: 300, empty: false })
  const d = repo({ fullName: 'd/d', updatedAt: 50, empty: true })

  assert.deepEqual(
    sortRepos([a, b, c, d]).map((item) => item.fullName),
    ['d/d', 'b/b', 'c/c', 'a/a'],
  )
})

test('sortRepos: updatedAt 相同的保持传入顺序', () => {
  const first = repo({ fullName: 'first/first', updatedAt: 10 })
  const second = repo({ fullName: 'second/second', updatedAt: 10 })
  const third = repo({ fullName: 'third/third', updatedAt: 10 })

  assert.deepEqual(
    sortRepos([first, second, third]).map((item) => item.fullName),
    ['first/first', 'second/second', 'third/third'],
  )
})

test('sortRepos: 不原地修改传入数组', () => {
  const list = [
    repo({ fullName: 'old/old', updatedAt: 1 }),
    repo({ fullName: 'new/new', updatedAt: 2 }),
  ]
  const snapshot = list.map((item) => item.fullName)

  sortRepos(list)

  assert.deepEqual(
    list.map((item) => item.fullName),
    snapshot,
  )
})

test('sortRepos: updatedAt 缺失 / NaN 当 0 处理', () => {
  const broken = repo({ fullName: 'broken/broken', updatedAt: Number.NaN })
  const normal = repo({ fullName: 'normal/normal', updatedAt: 5 })

  assert.deepEqual(
    sortRepos([broken, normal]).map((item) => item.fullName),
    ['normal/normal', 'broken/broken'],
  )
})

/* ---------- accountLabel ---------- */

test('accountLabel: GitHub 主机不带端口', () => {
  assert.equal(
    accountLabel(account({ kind: 'github', baseUrl: 'https://github.com', username: 'me' })),
    'me @ github.com',
  )
})

test('accountLabel: 自建 Gitea 主机带端口', () => {
  assert.equal(accountLabel(account({})), 'luyongkang777 @ 192.168.31.8:3000')
})

test('accountLabel: 结尾斜杠不影响主机解析', () => {
  assert.equal(
    accountLabel(account({ baseUrl: 'https://gitea.example.com/', username: 'dev' })),
    'dev @ gitea.example.com',
  )
})

test('accountLabel: 没写协议也能解析主机与端口', () => {
  assert.equal(
    accountLabel(account({ baseUrl: '192.168.31.8:3000', username: 'dev' })),
    'dev @ 192.168.31.8:3000',
  )
})

test('accountLabel: username 为空只显示主机', () => {
  assert.equal(
    accountLabel(account({ username: '', baseUrl: 'http://192.168.31.8:3000' })),
    '192.168.31.8:3000',
  )
})

test('accountLabel: 地址与用户名都为空时给空串', () => {
  assert.equal(accountLabel(account({ username: '', baseUrl: '' })), '')
})
