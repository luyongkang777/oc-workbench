// 第三方 API 接入的纯函数回归。
// node --experimental-strip-types --test scripts/providerFormat.test.mjs
//
// 四类错最容易出：
//   1. baseURL 不补 /v1 → 保存后请求全 404，用户看不出是地址少了一段；
//   2. 掩码露太多字符 = 把 key 说出去一半；
//   3. id 允许斜杠 / 空格 → 写进 JSON 键和模型 id 前缀后一路出错；
//   4. 合并模型时用覆盖而不是并集 → 手填的模型凭空消失。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEEPSEEK_BASE_URL,
  maskKey,
  mergeModelIds,
  modelDisplayName,
  normalizeBaseURL,
  pickModelIds,
  prettyModelName,
  validateDraft,
} from '../src/api/providerFormat.ts'

test('域名根自动补 /v1，已带版本段的不重复补', () => {
  assert.equal(normalizeBaseURL('https://api.deepseek.com'), 'https://api.deepseek.com/v1')
  assert.equal(normalizeBaseURL('https://api.deepseek.com/'), 'https://api.deepseek.com/v1')
  assert.equal(normalizeBaseURL('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1')
  assert.equal(normalizeBaseURL('https://api.deepseek.com/v1///'), 'https://api.deepseek.com/v1')
  // 中转站常见的多段前缀
  assert.equal(normalizeBaseURL('https://x.com/openai/v1'), 'https://x.com/openai/v1')
  assert.equal(normalizeBaseURL('https://x.com/openai'), 'https://x.com/openai/v1')
  // 版本段后面还带后缀（v1beta）
  assert.equal(normalizeBaseURL('https://x.com/v1beta'), 'https://x.com/v1beta')
  // 本地地址
  assert.equal(normalizeBaseURL('http://127.0.0.1:3425'), 'http://127.0.0.1:3425/v1')
})

test('非法地址与协议一律返回空串', () => {
  assert.equal(normalizeBaseURL(''), '')
  assert.equal(normalizeBaseURL('   '), '')
  assert.equal(normalizeBaseURL('api.deepseek.com'), '')
  assert.equal(normalizeBaseURL('ftp://x.com/v1'), '')
  assert.equal(normalizeBaseURL('file:///c:/x'), '')
})

test('搜索串与锚点被剥掉', () => {
  assert.equal(normalizeBaseURL('https://x.com/v1?a=1#b'), 'https://x.com/v1')
})

test('密钥掩码只露头尾 4 个字符，太短整串打星', () => {
  assert.equal(maskKey('sk-1234567890abcdef'), 'sk-1…cdef')
  assert.equal(maskKey('short'), '*****')
  assert.equal(maskKey(''), '')
  assert.equal(maskKey(undefined), '')
  // 掩码结果里不能出现中间的字符
  const masked = maskKey('sk-abcdefghijklmnop')
  assert.ok(!masked.includes('efgh'))
})

test('草稿校验：合法草稿通过', () => {
  assert.deepEqual(
    validateDraft({
      id: 'deepseek',
      name: 'DeepSeek 官方',
      baseURL: DEEPSEEK_BASE_URL,
      apiKey: 'sk-1234567890abcdef',
    }),
    { ok: true },
  )
})

test('草稿校验：四种非法输入各给一句人话', () => {
  const base = { id: 'x', name: 'x', baseURL: 'https://x.com/v1', apiKey: 'sk-1234567890' }
  assert.equal(validateDraft({ ...base, id: '' }).ok, false)
  assert.equal(validateDraft({ ...base, id: 'a/b' }).ok, false)
  assert.equal(validateDraft({ ...base, id: 'a b' }).ok, false)
  assert.equal(validateDraft({ ...base, baseURL: 'nope' }).ok, false)
  assert.equal(validateDraft({ ...base, apiKey: '' }).ok, false)
  assert.equal(validateDraft({ ...base, apiKey: 'sk-123 456' }).ok, false)
})

test('模型合并是并集：远端漏掉的已启用模型不能消失', () => {
  const merged = mergeModelIds(['deepseek-chat', 'deepseek-reasoner'], ['my-custom-model'])
  assert.deepEqual(merged, ['deepseek-chat', 'deepseek-reasoner', 'my-custom-model'])
  // 重复项去重
  assert.deepEqual(mergeModelIds(['a', 'a'], ['a']), ['a'])
  // 空值不算模型
  assert.deepEqual(mergeModelIds(['', '  '], ['b']), ['b'])
})

test('三种 /models 响应形状都能取出 id', () => {
  assert.deepEqual(pickModelIds({ data: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b'])
  assert.deepEqual(pickModelIds([{ id: 'a' }]), ['a'])
  assert.deepEqual(pickModelIds({ models: [{ name: 'c' }, { id: 'd' }] }), ['c', 'd'])
  assert.deepEqual(pickModelIds({ data: ['e'] }), ['e'])
  assert.deepEqual(pickModelIds(null), [])
  assert.deepEqual(pickModelIds({}), [])
})

test('模型 id 拆成人话名字：版本号不拆、品牌保留专有写法', () => {
  assert.equal(prettyModelName('deepseek-v4.1-flash'), 'DeepSeek V4.1 Flash')
  assert.equal(prettyModelName('deepseek/deepseek-v4.1-flash'), 'DeepSeek V4.1 Flash')
  assert.equal(prettyModelName('gpt-6.1-terra'), 'GPT 6.1 Terra')
  assert.equal(prettyModelName('glm-5.3'), 'GLM 5.3')
  assert.equal(prettyModelName('claude-sonnet-5-5'), 'Claude Sonnet 5 5')
  // 上游已经给了人话名字（有空格）就原样
  assert.equal(prettyModelName('Claude Sonnet 5.5'), 'Claude Sonnet 5.5')
  assert.equal(prettyModelName(''), '')
})

test('写进配置的模型名统一带商家名', () => {
  assert.equal(modelDisplayName('DeepSeek V4.1 Flash', 'OpenCode Go'), 'DeepSeek V4.1 Flash (OpenCode Go)')
  assert.equal(
    modelDisplayName('deepseek/deepseek-v4.1-flash', 'OpenCode Go'),
    'DeepSeek V4.1 Flash (OpenCode Go)',
  )
  // 已经带了同样的括号不重复
  assert.equal(
    modelDisplayName('DeepSeek V4.1 Flash (OpenCode Go)', 'OpenCode Go'),
    'DeepSeek V4.1 Flash (OpenCode Go)',
  )
  assert.equal(modelDisplayName('X', ''), 'X')
})
