// 强制规则：条目读写 + 老格式迁移 + 覆盖描述的单元测试。
//
// 重点验证「规则是条目，不是一大块」以及「没有开关」这两件事在数据结构上成立。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { coverageText, normalizeItems } from '../src/components/rulesFormat.ts'
import {
  localRuleFile,
  parseLegacyMarkdown,
  readRulesStatus,
  saveRule,
} from './dev-local-rules.mjs'

async function makeHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'oc-rules-'))
  await mkdir(path.join(home, '.config', 'opencode'), { recursive: true })
  return home
}

async function makeProject() {
  return mkdtemp(path.join(tmpdir(), 'oc-rules-proj-'))
}

test('没配过规则时两级都是空条目，active=false，且没有 enabled 字段', async () => {
  const home = await makeHome()
  const project = await makeProject()
  try {
    const status = await readRulesStatus(project, home)
    assert.equal(status.active, false)
    assert.equal(status.totalItems, 0)
    assert.deepEqual(status.global.items, [])
    assert.deepEqual(status.local.items, [])
    assert.equal('enabled' in status, false)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
})

test('保存条目：单行与标题+内容两种形态都保留，空内容被丢弃', async () => {
  const home = await makeHome()
  const project = await makeProject()
  try {
    const saved = await saveRule(
      'local',
      project,
      [
        { title: '', text: '改完必须跑 npm test' },
        { title: '行尾', text: '只能用 LF' },
        { title: '', text: '   ' },
      ],
      home,
    )
    assert.equal(saved.local.items.length, 2)
    assert.deepEqual(saved.local.items[0], { title: '', text: '改完必须跑 npm test' })
    assert.deepEqual(saved.local.items[1], { title: '行尾', text: '只能用 LF' })
    assert.equal(saved.totalItems, 2)
    assert.ok((await stat(localRuleFile(project))).isFile())
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
})

test('落盘是 JSON 条目格式（能被插件按序号增删改）', async () => {
  const home = await makeHome()
  const project = await makeProject()
  try {
    await saveRule('local', project, [{ title: '标题', text: '内容' }], home)
    const raw = JSON.parse(await readFile(localRuleFile(project), 'utf8'))
    assert.equal(raw.version, 1)
    assert.deepEqual(raw.items, [{ title: '标题', text: '内容' }])
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
})

test('全局与目录互不覆盖', async () => {
  const home = await makeHome()
  const project = await makeProject()
  try {
    await saveRule('global', '', [{ title: '', text: '一律用中文回答' }], home)
    await saveRule('local', project, [{ title: '', text: '改完必须跑测试' }], home)
    const status = await readRulesStatus(project, home)
    assert.equal(status.global.items[0].text, '一律用中文回答')
    assert.equal(status.local.items[0].text, '改完必须跑测试')
    assert.equal(status.totalItems, 2)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
})

test('清空条目 = 取消约束，但文件保留', async () => {
  const home = await makeHome()
  const project = await makeProject()
  try {
    await saveRule('local', project, [{ title: '', text: '先写一条' }], home)
    const cleared = await saveRule('local', project, [], home)
    assert.equal(cleared.active, false)
    assert.equal(cleared.local.exists, true)
    assert.deepEqual(cleared.local.items, [])
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
})

test('老格式 markdown 会被解析成条目，并在保存时迁移', async () => {
  const home = await makeHome()
  const project = await makeProject()
  try {
    const dir = path.join(project, '.opencode')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'rules.md'),
      '# 临时验证规则\n- 每次回答最后一行写 X\n\n- 第二条\n',
      'utf8',
    )
    const status = await readRulesStatus(project, home)
    assert.equal(status.local.items.length, 2)
    assert.deepEqual(status.local.items[0], { title: '临时验证规则', text: '每次回答最后一行写 X' })
    assert.equal(status.local.items[1].text, '第二条')

    // 保存后写成 JSON，老 md 改名留档
    await saveRule('local', project, status.local.items, home)
    const names = await readFile(localRuleFile(project), 'utf8')
    assert.match(names, /"items"/)
    await assert.rejects(() => stat(path.join(dir, 'rules.md')), /ENOENT/)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
})

test('parseLegacyMarkdown：标题+紧跟行成两行条目，普通行成单行条目', () => {
  const items = parseLegacyMarkdown('# 标题\n内容行\n普通一行\n')
  assert.deepEqual(items, [
    { title: '标题', text: '内容行' },
    { title: '', text: '普通一行' },
  ])
})

test('normalizeItems：非数组/坏对象一律安全忽略', () => {
  assert.deepEqual(normalizeItems(null), [])
  assert.deepEqual(normalizeItems([null, 1, 'x']), [])
  assert.deepEqual(normalizeItems([{ text: ' a ', title: ' t ' }]), [{ title: 't', text: 'a' }])
})

test('超过 500 条拒绝保存', async () => {
  const home = await makeHome()
  const project = await makeProject()
  try {
    const many = Array.from({ length: 501 }, (_, i) => ({ title: '', text: `规则 ${i}` }))
    await assert.rejects(() => saveRule('local', project, many, home), /上限/)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  }
})

test('缺 directory / 非法 scope 都拒绝', async () => {
  const home = await makeHome()
  try {
    await assert.rejects(() => saveRule('local', '', [{ title: '', text: 'x' }], home), /directory/)
    await assert.rejects(() => saveRule('whatever', '', [], home), /scope/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('coverageText：说明覆盖级别与条数，不说开关', () => {
  const base = {
    ok: true,
    directory: 'F:\\x',
    pluginInstalled: true,
    pluginDir: '',
    dataDir: '',
    maxBytes: 1024,
    readErrors: 0,
    active: true,
    totalItems: 2,
    global: {
      scope: 'global',
      path: 'g',
      exists: true,
      bytes: 1,
      mtimeMs: 1,
      error: null,
      items: [{ title: '', text: 'a' }],
      migratedFrom: '',
    },
    local: {
      scope: 'local',
      path: 'l',
      exists: true,
      bytes: 1,
      mtimeMs: 1,
      error: null,
      items: [{ title: 't', text: 'b' }],
      migratedFrom: '',
    },
  }
  assert.match(coverageText(base), /全局 \+ 目录/)
  assert.match(coverageText(base), /共 2 条/)
  assert.match(
    coverageText({
      ...base,
      global: { ...base.global, items: [] },
      local: { ...base.local, items: [] },
      totalItems: 0,
    }),
    /没有任何约束/,
  )
  assert.match(coverageText({ ...base, readErrors: 1 }), /写操作会被拦/)
})
