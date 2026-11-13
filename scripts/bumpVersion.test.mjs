// bump-version 的纯函数单测：版本算式 + 三个文件的改写 + notes 草稿过滤。
// 不做真实写盘，避免测试碰到仓库里的版本号。

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bumpCargoLock,
  bumpCargoToml,
  bumpPackageJson,
  draftNotes,
  nextVersion,
  parseVersion,
} from './bump-version.mjs'

test('parseVersion：认 v 前缀，拒绝不合法', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 })
  assert.deepEqual(parseVersion('v10.0.7'), { major: 10, minor: 0, patch: 7 })
  assert.equal(parseVersion('1.2'), null)
  assert.equal(parseVersion('1.2.3-beta'), null)
  assert.equal(parseVersion(''), null)
})

test('nextVersion：三个递增方向与直接指定', () => {
  assert.equal(nextVersion('1.1.2', 'patch'), '1.1.3')
  assert.equal(nextVersion('1.1.9', 'patch'), '1.1.10')
  assert.equal(nextVersion('1.1.2', 'minor'), '1.2.0')
  assert.equal(nextVersion('1.9.9', 'major'), '2.0.0')
  assert.equal(nextVersion('1.1.2', '2.0.0'), '2.0.0')
  assert.equal(nextVersion('1.1.2', 'v3.4.5'), '3.4.5')
  assert.throws(() => nextVersion('1.1.2', 'next'), /不合法/)
})

test('bumpPackageJson：只改 version，其它字段原样保留', () => {
  const raw = JSON.stringify(
    { name: 'oc-workbench', version: '1.1.2', scripts: { test: 'node --test' } },
    null,
    2,
  )
  const next = JSON.parse(bumpPackageJson(raw, '1.2.0'))
  assert.equal(next.version, '1.2.0')
  assert.equal(next.name, 'oc-workbench')
  assert.equal(next.scripts.test, 'node --test')
  assert.ok(bumpPackageJson(raw, '1.2.0').endsWith('\n'), '要保留结尾换行')
})

test('bumpCargoToml：只改包版本，不动依赖版本', () => {
  const raw = [
    '[package]',
    'name = "oc-workbench-shell"',
    'version = "1.1.2"',
    'edition = "2021"',
    '',
    '[dependencies]',
    'tao = "0.37"',
    'serde_json = "1"',
    '',
  ].join('\n')
  const next = bumpCargoToml(raw, '1.2.0')
  assert.match(next, /^version = "1\.2\.0"$/m)
  assert.match(next, /^tao = "0\.37"$/m, '依赖版本不能被改')
  assert.match(next, /^serde_json = "1"$/m)
  assert.throws(() => bumpCargoToml('[package]\nname = "x"\n', '1.0.0'), /没找到 version/)
})

test('bumpCargoLock：只改本 crate 的那一块', () => {
  const raw = [
    '[[package]]',
    'name = "serde_json"',
    'version = "1.0.154"',
    '',
    '[[package]]',
    'name = "oc-workbench-shell"',
    'version = "1.1.2"',
    'dependencies = [',
    ' "tao",',
    ']',
    '',
  ].join('\n')
  const next = bumpCargoLock(raw, '1.2.0')
  assert.match(next, /name = "serde_json"\nversion = "1\.0\.154"/, '别的包不能动')
  assert.match(next, /name = "oc-workbench-shell"\nversion = "1\.2\.0"/)
  assert.throws(() => bumpCargoLock('[[package]]\nname = "other"\n', '1.0.0'), /没找到/)
})

test('draftNotes：过滤噪音，保留用户能看懂的那几条', () => {
  const notes = draftNotes(
    [
      'feat: 顶栏显示版本号',
      'chore: 升级依赖',
      'docs: 补发版说明',
      'ci: 加流水线',
      'test: 修 flaky',
      'Merge branch main',
      'fix: 修 HTTPS 后端缺失',
      '',
    ],
    '1.2.0',
  )
  assert.ok(notes.includes('- 版本 1.2.0'))
  assert.ok(notes.includes('- feat: 顶栏显示版本号'))
  assert.ok(notes.includes('- fix: 修 HTTPS 后端缺失'))
  assert.ok(!notes.includes('chore:'), 'chore 不该出现在更新说明里')
  assert.ok(!notes.includes('Merge'), '合并提交要过滤')
})

test('draftNotes：没有可用提交时留一句占位，不产出空正文', () => {
  const notes = draftNotes(['chore: x', 'ci: y'], '1.2.1')
  assert.ok(notes.includes('（这次没有面向用户的改动）'))
  assert.ok(notes.includes('- 版本 1.2.1'))
})
