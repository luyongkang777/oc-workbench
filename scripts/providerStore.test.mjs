// dev 侧 provider 读写的回归（与 Rust 外壳同口径）。
//
// 重点验两件事：
//   1. 写一条 provider 不会冲掉文件里其它顶层键与其它 provider（真凭据在文件里）；
//   2. 坏 JSON 一律拒绝写，原文件一个字节不动。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { maskKey, parseSaveModels, readStatus, saveConfig, upsertProvider, removeProvider } from './dev-local-provider.mjs'

async function makeHome() {
  const home = await mkdtemp(path.join(tmpdir(), 'oc-provider-'))
  const dir = path.join(home, '.config', 'opencode')
  await mkdir(dir, { recursive: true })
  const previous = process.env.USERPROFILE
  process.env.USERPROFILE = home
  return {
    home,
    file: path.join(dir, 'opencode.json'),
    restore: () => {
      if (previous === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previous
    },
  }
}

const FULL = {
  model: 'purge/deepseek-flash',
  provider: {
    keepme: {
      name: 'Keep',
      options: { baseURL: 'https://keep.example/v1', apiKey: 'sk-keepkeykeepkey12' },
      models: { 'keep-model': { name: 'keep-model' } },
    },
  },
  mcp: { servers: {} },
  instructions: ['./rules/a.md'],
}

test('密钥掩码只露头尾', () => {
  assert.equal(maskKey('sk-1234567890abcdef'), 'sk-1…cdef')
  assert.equal(maskKey('short'), '*****')
  assert.equal(maskKey(''), '')
})

test('保存一条 provider 不动其它顶层键与其它 provider', async () => {
  const env = await makeHome()
  try {
    await writeFile(env.file, JSON.stringify(FULL, null, 2), 'utf8')
    saveConfig((config) =>
      upsertProvider(config, {
        id: 'deepseek',
        name: 'DeepSeek 官方',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'sk-newkey1234567890',
        models: ['deepseek-chat', 'deepseek-reasoner'],
      }),
    )

    const disk = JSON.parse(await readFile(env.file, 'utf8'))
    assert.equal(disk.model, 'purge/deepseek-flash')
    assert.deepEqual(disk.mcp, { servers: {} })
    assert.deepEqual(disk.instructions, ['./rules/a.md'])
    assert.equal(disk.provider.keepme.options.apiKey, 'sk-keepkeykeepkey12')
    assert.equal(disk.provider.deepseek.options.baseURL, 'https://api.deepseek.com/v1')
    assert.equal(disk.provider.deepseek.models['deepseek-chat'].name, 'deepseek-chat')
    assert.equal(disk.provider.deepseek.npm, '@ai-sdk/openai-compatible')
  } finally {
    env.restore()
    await rm(env.home, { recursive: true, force: true })
  }
})

test('覆盖 provider 时保留用户手调的 options', async () => {
  const env = await makeHome()
  try {
    // 中转站常要求自定义 header / timeout，用户在文件里手调过，工作台覆盖时不能丢
    await writeFile(
      env.file,
      JSON.stringify(
        {
          provider: {
            x: {
              name: 'X',
              options: { baseURL: 'https://old/v1', apiKey: 'sk-old1234567890', headers: { 'x-token': 'abc' }, timeout: 60000 },
              models: { m: { name: 'm' } },
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    )
    saveConfig((config) =>
      upsertProvider(config, { id: 'x', name: 'X', baseURL: 'https://new/v1', apiKey: 'sk-new1234567890', models: ['m'] }),
    )

    const disk = JSON.parse(await readFile(env.file, 'utf8'))
    const options = disk.provider.x.options
    assert.equal(options.baseURL, 'https://new/v1')
    assert.equal(options.apiKey, 'sk-new1234567890')
    assert.equal(options.headers['x-token'], 'abc')
    assert.equal(options.timeout, 60000)
  } finally {
    env.restore()
    await rm(env.home, { recursive: true, force: true })
  }
})

test('status 不回显明文 key', async () => {
  const env = await makeHome()
  try {
    await writeFile(env.file, JSON.stringify(FULL, null, 2), 'utf8')
    const status = readStatus()
    const text = JSON.stringify(status)
    assert.ok(!text.includes('sk-keepkeykeepkey12'), '明文 key 不能出现在 status 里')
    assert.equal(status.providers[0].keyMasked, 'sk-k…ey12')
    assert.equal(status.providers[0].hasKey, true)
  } finally {
    env.restore()
    await rm(env.home, { recursive: true, force: true })
  }
})

test('删除只删那一条，provider 段保留', async () => {
  const env = await makeHome()
  try {
    await writeFile(env.file, JSON.stringify(FULL, null, 2), 'utf8')
    saveConfig((config) => removeProvider(config, 'keepme'))
    const disk = JSON.parse(await readFile(env.file, 'utf8'))
    assert.deepEqual(disk.provider, {})
    assert.equal(disk.model, 'purge/deepseek-flash')
  } finally {
    env.restore()
    await rm(env.home, { recursive: true, force: true })
  }
})

test('坏 JSON 拒绝写且原文件不变', async () => {
  const env = await makeHome()
  try {
    const broken = '{"provider": {"x": tru'
    await writeFile(env.file, broken, 'utf8')
    assert.throws(
      () => saveConfig((config) => upsertProvider(config, { id: 'y', name: 'Y', baseURL: 'https://y/v1', apiKey: 'k', models: [] })),
      /不是合法 JSON/,
    )
    assert.equal(await readFile(env.file, 'utf8'), broken)
  } finally {
    env.restore()
    await rm(env.home, { recursive: true, force: true })
  }
})

test('保存会留一份备份', async () => {
  const env = await makeHome()
  try {
    await writeFile(env.file, JSON.stringify(FULL, null, 2), 'utf8')
    saveConfig((config) =>
      upsertProvider(config, { id: 'z', name: 'Z', baseURL: 'https://z/v1', apiKey: 'sk-1234567890abcdef', models: [] }),
    )
    const names = await readdir(path.dirname(env.file))
    assert.equal(names.filter((name) => name.startsWith('opencode.json.bak-')).length, 1)
  } finally {
    env.restore()
    await rm(env.home, { recursive: true, force: true })
  }
})

test('读失败拒绝写：路径是目录时不能把配置覆盖掉', async () => {
  const env = await makeHome()
  try {
    // 把一个目录当成 opencode.json：readFileSync 会报 EISDIR（不是 ENOENT）
    await mkdir(env.file, { recursive: true })
    assert.throws(
      () => saveConfig((config) => upsertProvider(config, { id: 'y', name: 'Y', baseURL: 'https://y/v1', apiKey: 'k', models: [] })),
      /读不了 opencode.json/,
    )
    // 目录还在，没有被改名覆盖
    assert.equal(await readFile(env.file).then(() => false, () => true), true)
  } finally {
    env.restore()
    await rm(env.home, { recursive: true, force: true })
  }
})

test('覆盖已有 provider 时保留未知字段与自定义 npm', async () => {
  const env = await makeHome()
  try {
    await writeFile(
      env.file,
      JSON.stringify({
        provider: {
          x: {
            name: 'X',
            npm: '@ai-sdk/openai',
            env: ['A=1'],
            blacklist: ['b'],
            options: { baseURL: 'https://x/v1', apiKey: 'sk-1234567890abcdef', headers: { 'x-k': 'v' } },
            models: { m: { name: 'm' } },
          },
        },
      }),
      'utf8',
    )
    saveConfig((config) =>
      upsertProvider(config, { id: 'x', name: 'X2', baseURL: 'https://x/v1', apiKey: 'sk-1234567890abcdef', models: ['m'] }),
    )
    const disk = JSON.parse(await readFile(env.file, 'utf8'))
    const entry = disk.provider.x
    assert.equal(entry.npm, '@ai-sdk/openai', '自定义 npm 不能被改写')
    assert.deepEqual(entry.env, ['A=1'])
    assert.deepEqual(entry.blacklist, ['b'])
    assert.equal(entry.options.headers['x-k'], 'v', 'options 手调字段要保留')
    assert.equal(entry.name, 'X2')
  } finally {
    env.restore()
    await rm(env.home, { recursive: true, force: true })
  }
})

test('备份轮转真的删得掉（留 10 份，不能越堆越多）', async () => {
  const env = await makeHome()
  try {
    await writeFile(env.file, JSON.stringify(FULL, null, 2), 'utf8')
    for (let index = 0; index < 13; index++) {
      saveConfig((config) =>
        upsertProvider(config, {
          id: 'x',
          name: 'X',
          baseURL: 'https://x/v1',
          apiKey: 'sk-1234567890abcdef',
          models: [],
        }),
      )
    }
    const backups = (await readdir(path.dirname(env.file))).filter((name) =>
      name.startsWith('opencode.json.bak-'),
    )
    // 曾经因为「完整路径又 join 了一次」导致删除全部失败，堆到 40+ 份
    assert.equal(backups.length, 10, `备份数应该被压到 10，实际 ${backups.length}`)
  } finally {
    env.restore()
    await rm(env.home, { recursive: true, force: true })
  }
})

test('本机没有顶层 model 时，首次设默认模型能写进去（曾经 500）', async () => {
  const env = await makeHome()
  try {
    // 另一台电脑的现场：默认模型显示「未设置」，选任意模型都会被自检判成「动了别的配置」
    await writeFile(env.file, JSON.stringify({ provider: {}, instructions: ['./rules/a.md'] }), 'utf8')
    saveConfig((config) => {
      config.model = 'deepseek/deepseek-chat'
    })
    const disk = JSON.parse(await readFile(env.file, 'utf8'))
    assert.equal(disk.model, 'deepseek/deepseek-chat')
    assert.deepEqual(disk.instructions, ['./rules/a.md'])
  } finally {
    env.restore()
    await rm(env.home, { recursive: true, force: true })
  }
})

test('自检仍然拦住其它顶层键被改、以及删掉 model', async () => {
  const env = await makeHome()
  try {
    const original = JSON.stringify({ model: 'a/b', provider: {}, mcp: { servers: {} } })
    await writeFile(env.file, original, 'utf8')
    assert.throws(() => saveConfig((config) => { config.mcp = 'broken' }), /自检失败/)
    assert.throws(() => saveConfig((config) => { delete config.model }), /自检失败/)
    assert.equal(await readFile(env.file, 'utf8'), original, '两次被拦都要保持原文件')
  } finally {
    env.restore()
    await rm(env.home, { recursive: true, force: true })
  }
})

test('model 为 null 这种旧值也能纠正成字符串（下拉显示未设置却存不进去）', async () => {
  const env = await makeHome()
  try {
    // 读取侧把 null 当「未设置」，写回侧若按「类型不能变」拒绝，用户就永远设不上默认模型
    await writeFile(env.file, JSON.stringify({ model: null, provider: {} }), 'utf8')
    saveConfig((config) => {
      config.model = 'deepseek/deepseek-chat'
    })
    const disk = JSON.parse(await readFile(env.file, 'utf8'))
    assert.equal(disk.model, 'deepseek/deepseek-chat')
  } finally {
    env.restore()
    await rm(env.home, { recursive: true, force: true })
  }
})

test('已有字符串 model 换成另一个模型', async () => {
  const env = await makeHome()
  try {
    await writeFile(env.file, JSON.stringify({ model: 'a/b', provider: {}, instructions: [] }), 'utf8')
    saveConfig((config) => {
      config.model = 'c/d'
    })
    const disk = JSON.parse(await readFile(env.file, 'utf8'))
    assert.equal(disk.model, 'c/d')
    assert.deepEqual(disk.instructions, [])
  } finally {
    env.restore()
    await rm(env.home, { recursive: true, force: true })
  }
})

test('model 为 null 时保存 provider 不能被拦（没碰 model）', async () => {
  const env = await makeHome()
  try {
    // 这条是回归防线：曾经把「写回后 model 必须是字符串」当成无条件要求，
    // 结果只要配置里是 "model": null，保存/删除 provider 全部 500。
    await writeFile(env.file, JSON.stringify({ model: null, provider: {}, mcp: { servers: {} } }), 'utf8')
    saveConfig((config) =>
      upsertProvider(config, {
        id: 'x',
        name: 'X',
        baseURL: 'https://x/v1',
        apiKey: 'sk-1234567890abcdef',
        models: [],
      }),
    )
    const disk = JSON.parse(await readFile(env.file, 'utf8'))
    assert.equal(disk.provider.x.options.baseURL, 'https://x/v1')
    assert.equal(disk.model, null, '没碰的 model 要保持原样')
    assert.deepEqual(disk.mcp, { servers: {} })
  } finally {
    env.restore()
    await rm(env.home, { recursive: true, force: true })
  }
})

test('parseSaveModels 两种写法都收，对象不能被丢掉', () => {
  // 面板传的是对象数组（带上下文/输出）；以前这里只留字符串，
  // 结果「保存成功但模型一个都没写进去」——只在 dev 复现，exe 里正常。
  const list = parseSaveModels([
    { id: 'deepseek-v4.1-flash-free', name: 'DS Free', context: 200000, output: 32000 },
    'plain-id',
    { id: '   ' },
    null,
  ])
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'deepseek-v4.1-flash-free')
  assert.equal(list[0].context, 200000)
  assert.equal(list[1], 'plain-id')
  // 非数组 / 缺字段一律给空数组，不抛
  assert.deepEqual(parseSaveModels(undefined), [])
  assert.deepEqual(parseSaveModels({}), [])
})

test('保存对象数组时上下文与输出要落盘成 limit', async () => {
  const env = await makeHome()
  try {
    await writeFile(env.file, JSON.stringify(FULL, null, 2), 'utf8')
    const models = parseSaveModels([
      { id: 'deepseek-v4.1-flash-free', name: 'DS Free', context: 200000, output: 32000 },
      { id: 'longcat-2.5-free', name: 'LongCat', context: 1000000, output: 0 },
    ])
    saveConfig((config) =>
      upsertProvider(config, {
        id: 'opencode-free',
        name: 'OpenCode 免费模型',
        baseURL: 'https://opencode.ai/inference/openai/v1',
        apiKey: 'public',
        models,
      }),
    )
    const disk = JSON.parse(await readFile(env.file, 'utf8'))
    const entry = disk.provider['opencode-free']
    assert.equal(entry.options.apiKey, 'public')
    assert.deepEqual(entry.models['deepseek-v4.1-flash-free'].limit, { context: 200000, output: 32000 })
    // output 为 0 时不写 output 字段（写死会截断大输出模型）
    assert.deepEqual(entry.models['longcat-2.5-free'].limit, { context: 1000000 })
    // 其它 provider 与顶层键不被冲掉
    assert.equal(disk.provider.keepme.options.apiKey, 'sk-keepkeykeepkey12')
    assert.equal(disk.model, 'purge/deepseek-flash')
  } finally {
    env.restore()
    await rm(env.home, { recursive: true, force: true })
  }
})
