// 斜杠命令菜单纯逻辑的回归测试。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILTIN_COMMANDS,
  filterCommands,
  findCommand,
  mergeCommands,
  parseSlash,
} from '../src/components/chatCommands.ts'

test('内置命令名字唯一，且覆盖 agents/compact/new', () => {
  const names = BUILTIN_COMMANDS.map((item) => item.name)
  assert.equal(new Set(names).size, names.length)
  for (const name of ['agents', 'compact', 'new', 'copy']) {
    assert.ok(names.includes(name), name)
  }
})

test('TUI 专有命令保留并标灰，可执行命令标记 builtin', () => {
  const byName = new Map(BUILTIN_COMMANDS.map((item) => [item.name, item]))
  for (const name of ['btw', 'cd', 'connect', 'debug', 'models', 'variants', 'worktrees']) {
    const item = byName.get(name)
    assert.ok(item, name)
    assert.equal(item.disabled, true)
  }
  assert.equal(byName.get('cd')?.note, '文件树')
  assert.equal(byName.get('models')?.note, '顶栏')
  assert.equal(byName.get('variants')?.note, '顶栏')
  for (const name of ['agents', 'compact', 'copy', 'fork', 'new', 'clear', 'continue']) {
    const item = byName.get(name)
    assert.ok(item, name)
    assert.ok(item.builtin, name)
  }
  for (const item of BUILTIN_COMMANDS) {
    assert.ok(item.builtin || item.disabled, item.name)
  }
})

test('合并服务端命令后按名字排序', () => {
  const list = mergeCommands(BUILTIN_COMMANDS, [
    { name: 'swarm', description: '集群开关' },
    { name: 'goal', description: '目标' },
  ])
  const names = list.map((item) => item.name)
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)))
  assert.ok(names.includes('swarm'))
  assert.ok(names.includes('goal'))
})

test('过滤：名字或别名包含关键字，大小写不敏感', () => {
  const list = mergeCommands(BUILTIN_COMMANDS, [{ name: 'deepseek-balance' }])
  assert.deepEqual(
    filterCommands(list, 'AGENT').map((item) => item.name),
    ['agents'],
  )
  assert.deepEqual(
    filterCommands(list, 'resume').map((item) => item.name),
    ['continue'],
  )
  assert.deepEqual(
    filterCommands(list, 'balance').map((item) => item.name),
    ['deepseek-balance'],
  )
  assert.equal(filterCommands(list, '').length, list.length)
})

test('解析斜杠命令：名字、参数、非命令', () => {
  assert.deepEqual(parseSlash('/goal 实现登录'), { name: 'goal', args: '实现登录' })
  assert.deepEqual(parseSlash('/swarm on'), { name: 'swarm', args: 'on' })
  assert.deepEqual(parseSlash('/compact'), { name: 'compact', args: '' })
  assert.deepEqual(parseSlash('  /vkb 搜索  '), { name: 'vkb', args: '搜索' })
  assert.equal(parseSlash('普通消息'), null)
  assert.equal(parseSlash('/'), null)
  assert.deepEqual(parseSlash('/name with space'), { name: 'name', args: 'with space' })
})

test('按名字或别名查找命令', () => {
  const list = mergeCommands(BUILTIN_COMMANDS, [])
  assert.equal(findCommand(list, 'continue')?.builtin, 'sessions')
  assert.equal(findCommand(list, 'resume')?.builtin, 'sessions')
  assert.equal(findCommand(list, 'nope'), undefined)
})
