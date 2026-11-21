// 技能清单清洗与过滤的回归测试。
import assert from 'node:assert/strict'
import test from 'node:test'

import { filterSkills, normalizeSkills, skillSource } from '../src/components/skillList.ts'

test('清洗：兼容数组和 {data}，丢掉无名条目，按 id 去重', () => {
  const raw = {
    data: [
      { id: 'b', name: 'beta', description: '第二', path: 'C:\\skills\\beta\\SKILL.md' },
      { id: 'a', name: 'alpha', description: '第一', path: '/home/u/.config/opencode/skills/alpha/SKILL.md' },
      { id: 'b', name: 'beta-dup' },
      { name: '' },
      'nonsense',
      null,
    ],
  }
  const list = normalizeSkills(raw)
  assert.deepEqual(list.map((s) => s.id), ['a', 'b'])
  assert.equal(list[0].name, 'alpha')
  assert.equal(list[1].source, 'beta')
  assert.deepEqual(normalizeSkills([{ id: 'x', name: 'x' }]).map((s) => s.id), ['x'])
  assert.deepEqual(normalizeSkills(null), [])
  assert.deepEqual(normalizeSkills({ data: 'oops' }), [])
})

test('没有 name 时用 id 兜底；没有 id 时用 name', () => {
  const list = normalizeSkills([{ id: 'only-id' }, { name: 'only-name' }])
  assert.deepEqual(list.map((s) => s.name), ['only-id', 'only-name'])
  assert.deepEqual(list.map((s) => s.id), ['only-id', 'only-name'])
})

test('来源目录：取 SKILL.md 的父目录，不把 skills 当来源', () => {
  assert.equal(skillSource('C:\\Users\\u\\.config\\opencode\\skills\\ida\\SKILL.md'), 'ida')
  assert.equal(skillSource('/a/skills/SKILL.md'), '')
  assert.equal(skillSource(''), '')
})

test('过滤：名字 / 描述 / 路径都算，大小写不敏感', () => {
  const list = normalizeSkills([
    { id: 'ida', name: 'ida', description: '用 IDA Pro 反汇编', path: '/s/ida/SKILL.md' },
    { id: 'x64', name: 'x96dbg', description: '动态调试', path: '/s/x96dbg/SKILL.md' },
  ])
  assert.deepEqual(filterSkills(list, 'IDA').map((s) => s.name), ['ida'])
  assert.deepEqual(filterSkills(list, '动态').map((s) => s.name), ['x96dbg'])
  assert.deepEqual(filterSkills(list, 'x96dbg').map((s) => s.name), ['x96dbg'])
  assert.equal(filterSkills(list, '   ').length, 2)
  assert.equal(filterSkills(list, '不存在').length, 0)
})

test('保留 SKILL.md 全文，正文不做 trim', () => {
  const body = '# 标题\n\n正文...\n'
  const list = normalizeSkills([{ id: 'x', name: 'x', content: body }, { id: 'y', name: 'y' }])
  assert.equal(list.find((item) => item.id === 'x')?.content, body)
  assert.equal(list.find((item) => item.id === 'y')?.content, '')
  // 非字符串的 content 当没有处理，不能把对象塞进去
  assert.equal(normalizeSkills([{ id: 'z', name: 'z', content: { a: 1 } }])[0].content, '')
})
