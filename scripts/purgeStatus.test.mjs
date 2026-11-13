// 破甲开关接口的单测：全部在临时 home 里跑，不碰真实的 ~/.config/opencode。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readPurgeStatus, setPurgeEnabled } from './dev-local-purge.mjs'

async function makeHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'oc-purge-'))
  await mkdir(path.join(home, '.config', 'opencode', 'purge'), { recursive: true })
  return home
}

async function writeConfig(home, config) {
  await writeFile(path.join(home, '.config', 'opencode', 'purge', 'config.json'), config, 'utf8')
}

test('配置缺失时按插件默认值：开，且标出没有文件', async () => {
  const home = await makeHome()
  try {
    const status = await readPurgeStatus(home)
    assert.equal(status.ok, true)
    assert.equal(status.enabled, true)
    assert.equal(status.configExists, false)
    assert.equal(status.configError, '')
    assert.deepEqual(status.perModel, [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('关闭开关会落盘，并保留 perModel 等手改字段', async () => {
  const home = await makeHome()
  try {
    await writeConfig(
      home,
      JSON.stringify({
        enabled: true,
        injectDefault: false,
        promptFile: 'prompt-inject.md',
        perModel: { 'purge/auto/GLM-5.3': 'prompts/glm.md' },
        temperature: null,
        tools: { deny: ['write'] },
        verbose: true,
        customField: 'keep-me',
      }),
    )

    const next = await setPurgeEnabled(false, home)
    assert.equal(next.enabled, false)

    const raw = JSON.parse(
      await readFile(path.join(home, '.config', 'opencode', 'purge', 'config.json'), 'utf8'),
    )
    assert.equal(raw.enabled, false)
    assert.equal(raw.injectDefault, false)
    assert.deepEqual(raw.perModel, { 'purge/auto/GLM-5.3': 'prompts/glm.md' })
    assert.deepEqual(raw.tools, { deny: ['write'] })
    assert.equal(raw.customField, 'keep-me')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('显式 "false" 字符串也算关（与插件 normalize 一致）', async () => {
  const home = await makeHome()
  try {
    await writeConfig(home, JSON.stringify({ enabled: 'false' }))
    assert.equal((await readPurgeStatus(home)).enabled, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('坏 JSON 拒绝写入，磁盘内容原样保留', async () => {
  const home = await makeHome()
  const file = path.join(home, '.config', 'opencode', 'purge', 'config.json')
  try {
    await writeFile(file, '{"enabled": tru', 'utf8')
    const status = await readPurgeStatus(home)
    assert.match(status.configError, /不是合法 JSON/)

    await assert.rejects(() => setPurgeEnabled(false, home), (err) => err.status === 409)
    assert.equal(await readFile(file, 'utf8'), '{"enabled": tru')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('提示词先找插件 prompts 目录，找不到再落到数据目录', async () => {
  const home = await makeHome()
  const pluginPrompts = path.join(home, '.config', 'opencode', 'plugins', 'purge', 'prompts')
  try {
    await mkdir(pluginPrompts, { recursive: true })
    await writeFile(path.join(pluginPrompts, 'glm.md'), 'x'.repeat(11), 'utf8')
    await writeConfig(
      home,
      JSON.stringify({
        enabled: true,
        promptFile: 'prompt-inject.md',
        perModel: {
          'purge/auto/GLM-5.3': 'prompts/glm.md',
          'purge/auto/gpt-6-sol': 'prompts/missing.md',
        },
      }),
    )

    const status = await readPurgeStatus(home)
    const glm = status.perModel.find((item) => item.key === 'purge/auto/GLM-5.3')
    const missing = status.perModel.find((item) => item.key === 'purge/auto/gpt-6-sol')

    assert.equal(glm.path, path.join(pluginPrompts, 'glm.md'))
    assert.equal(glm.exists, true)
    assert.equal(glm.bytes, 11)
    assert.equal(missing.path, path.join(home, '.config', 'opencode', 'purge', 'prompts', 'missing.md'))
    assert.equal(missing.exists, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('state.json 原样透出，供界面显示注入次数与最近时间', async () => {
  const home = await makeHome()
  try {
    await writeFile(
      path.join(home, '.config', 'opencode', 'purge', 'state.json'),
      JSON.stringify({ requests: 7, injects: 3, lastAt: 1700000000000, lastBytes: 1234 }),
      'utf8',
    )
    const status = await readPurgeStatus(home)
    assert.equal(status.state.injects, 3)
    assert.equal(status.state.lastAt, 1700000000000)
    assert.equal(status.state.lastBytes, 1234)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('keywordMap 透出为带 exists 的数组，key 统一小写', async () => {
  const home = await makeHome()
  const pluginPrompts = path.join(home, '.config', 'opencode', 'plugins', 'purge', 'prompts')
  try {
    await mkdir(pluginPrompts, { recursive: true })
    await writeFile(path.join(pluginPrompts, 'gpt.md'), 'abc', 'utf8')
    await writeConfig(
      home,
      JSON.stringify({ enabled: true, keywordMap: { GPT: 'prompts/gpt.md', glm: 'prompts/nope.md' } }),
    )

    const status = await readPurgeStatus(home)
    assert.equal(status.keywords.length, 2)
    const gpt = status.keywords.find((item) => item.keyword === 'gpt')
    const glm = status.keywords.find((item) => item.keyword === 'glm')
    assert.equal(gpt.exists, true)
    assert.equal(gpt.bytes, 3)
    assert.equal(gpt.path, path.join(pluginPrompts, 'gpt.md'))
    assert.equal(glm.exists, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('没有 keywordMap 时为 null；显式 false 时为空数组', async () => {
  const home = await makeHome()
  try {
    await writeConfig(home, JSON.stringify({ enabled: true }))
    assert.equal((await readPurgeStatus(home)).keywords, null)

    await writeConfig(home, JSON.stringify({ enabled: true, keywordMap: false }))
    assert.deepEqual((await readPurgeStatus(home)).keywords, [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('关键词匹配与插件一致：大小写不敏感、长词优先、无关键词不命中', async () => {
  const { matchPurgeKeyword } = await import('../src/api/purgeMatch.ts')
  const keywords = [
    { keyword: 'glm', file: 'prompts/glm.md' },
    { keyword: 'gpt', file: 'prompts/gpt.md' },
    { keyword: 'deepseek', file: 'prompts/deepseek.md' },
    { keyword: 'claude', file: 'prompts/claude.md' },
    { keyword: 'grok', file: 'prompts/grok.md' },
    { keyword: 'gemini', file: 'prompts/gemini.md' },
    { keyword: 'seek', file: 'prompts/seek.md' },
  ]

  assert.equal(matchPurgeKeyword(keywords, 'auto/gpt-6.2-sol')?.keyword, 'gpt')
  assert.equal(matchPurgeKeyword(keywords, 'auto/GLM-5.3')?.keyword, 'glm')
  assert.equal(matchPurgeKeyword(keywords, 'claude/claude-opus-4.5')?.keyword, 'claude')
  assert.equal(matchPurgeKeyword(keywords, 'cursor/grok-5')?.keyword, 'grok')
  assert.equal(matchPurgeKeyword(keywords, 'google/gemini-3-pro')?.keyword, 'gemini')
  // deepseek 比自定义短词 seek 长，必须优先命中
  assert.equal(matchPurgeKeyword(keywords, 'deepseek/deepseek-v5')?.keyword, 'deepseek')
  assert.equal(matchPurgeKeyword(keywords, 'mimo-v2.6-pro'), null)
  assert.equal(matchPurgeKeyword([], 'auto/gpt-6.2-sol'), null)
  // 配置缺失时按插件内置关键词兜底
  assert.equal(matchPurgeKeyword(null, 'auto/gpt-6.2-sol')?.file, 'prompts/gpt.md')
  assert.equal(matchPurgeKeyword(null, 'google/gemini-2.5-flash')?.file, 'prompts/gemini.md')
})
