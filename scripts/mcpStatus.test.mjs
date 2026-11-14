// MCP 读数回归测试：node --experimental-strip-types --test scripts/mcpStatus.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  mcpChipLabel,
  mcpChipTitle,
  mcpErrorHint,
  mcpStatusText,
  mcpTone,
  normalizeMcpServers,
  shortMcpError,
  sortMcpServers,
  summarizeMcp,
} from '../src/components/mcpStatus.ts'

const server = (name, status, error) => ({
  name,
  status: error === undefined ? { status } : { status, error },
})

test('正常记录保留名字与状态', () => {
  const list = normalizeMcpServers([
    server('ida', 'connected'),
    server('x64', 'failed', 'ECONNREFUSED'),
    server('auth', 'needs_auth', '需要登录'),
  ])
  assert.equal(list.length, 3)
  assert.equal(list[0].name, 'ida')
  assert.equal(list[0].status, 'connected')
  assert.equal(list[1].error, 'ECONNREFUSED')
  assert.equal(list[2].status, 'needs_auth')
})

test('没有 name 的记录丢掉，非数组返回空', () => {
  assert.deepEqual(normalizeMcpServers([{ status: { status: 'connected' } }]), [])
  assert.deepEqual(normalizeMcpServers(null), [])
  assert.deepEqual(normalizeMcpServers({}), [])
})

test('未知状态收成 unknown，不冒充已连接', () => {
  const list = normalizeMcpServers([server('odd', 'weird-state')])
  assert.equal(list[0].status, 'unknown')
  assert.equal(mcpTone('unknown'), 'muted')
  assert.equal(mcpStatusText('unknown'), '状态未知')
})

test('缺 status 字段也不崩', () => {
  const list = normalizeMcpServers([{ name: 'bare' }])
  assert.equal(list.length, 1)
  assert.equal(list[0].status, 'unknown')
  assert.equal(list[0].error, undefined)
})

test('汇总计数：failed + needs_auth 算异常，pending 不算', () => {
  const list = normalizeMcpServers([
    server('a', 'connected'),
    server('b', 'connected'),
    server('c', 'failed', 'refused'),
    server('d', 'needs_auth', 'auth'),
    server('e', 'pending'),
    server('f', 'disabled'),
  ])
  const summary = summarizeMcp(list)
  assert.deepEqual(summary, {
    total: 6,
    connected: 2,
    failed: 1,
    pending: 1,
    disabled: 1,
    needsAuth: 1,
    broken: 2,
  })
})

test('读数是「已连接/总数」；空列表不显示', () => {
  const summary = summarizeMcp(normalizeMcpServers([server('a', 'connected'), server('b', 'failed', 'x')]))
  assert.equal(mcpChipLabel(summary), 'MCP 1/2')
  assert.equal(mcpChipLabel(summarizeMcp([])), '')
})

test('悬停文案把异常和连接中都说清楚', () => {
  const summary = summarizeMcp(
    normalizeMcpServers([
      server('a', 'connected'),
      server('b', 'failed', 'x'),
      server('c', 'pending'),
    ]),
  )
  assert.equal(mcpChipTitle(summary), 'MCP 服务器：已连接 1/3 · 失败 1 · 连接中 1')
})

test('排序：失败 → 需授权 → 未知 → 连接中 → 已连接 → 停用，组内按名字', () => {
  const list = normalizeMcpServers([
    server('zeta', 'connected'),
    server('alpha', 'connected'),
    server('s2', 'failed', 'x'),
    server('s1', 'failed', 'y'),
    server('auth', 'needs_auth', 'z'),
    server('pend', 'pending'),
    server('off', 'disabled'),
  ])
  assert.deepEqual(sortMcpServers(list).map((item) => item.name), [
    's1',
    's2',
    'auth',
    'pend',
    'alpha',
    'zeta',
    'off',
  ])
  // 不改原数组
  assert.equal(list[0].name, 'zeta')
})

test('错误原文压成一行并截断', () => {
  assert.equal(shortMcpError(undefined), '')
  assert.equal(shortMcpError('  a\n\nb  '), 'a b')
  const long = 'x'.repeat(200)
  const short = shortMcpError(long)
  assert.equal(short.length, 90)
  assert.ok(short.endsWith('…'))
})

test('错误原文翻成中文摘要，原文留给 title', () => {
  assert.equal(
    mcpErrorHint('ECONNREFUSED: Unable to connect. Is the computer able to access the url?'),
    '连不上：目标端口没有在监听',
  )
  assert.equal(mcpErrorHint('connect ETIMEDOUT 1.2.3.4:80'), '连接超时')
  assert.equal(mcpErrorHint('request failed: 401 Unauthorized'), '需要授权或令牌失效')
  // 端口号里出现 4013/4031 不能误判成授权错误
  assert.equal(mcpErrorHint('connect failed to port 4013'), 'connect failed to port 4013')
  assert.equal(mcpErrorHint('bad gateway 4031'), 'bad gateway 4031')
  assert.equal(mcpErrorHint('ENOTFOUND mcp.example.com'), '域名解析失败')
  // 认不出来的原样返回（仍然压成一行）
  assert.equal(mcpErrorHint('something odd happened'), 'something odd happened')
  assert.equal(mcpErrorHint(undefined), '')
})

test('灯色档位', () => {
  assert.equal(mcpTone('connected'), 'ok')
  assert.equal(mcpTone('pending'), 'pending')
  assert.equal(mcpTone('failed'), 'bad')
  assert.equal(mcpTone('needs_auth'), 'bad')
  assert.equal(mcpTone('disabled'), 'muted')
})
