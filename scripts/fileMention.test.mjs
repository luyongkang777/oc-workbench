/**
 * `@` 文件提及的纯逻辑单测。
 *
 * 重点覆盖「什么时候该弹菜单」和「插入后的文本/光标」，这两个错一个就整个交互跑偏。
 * 注意：caret 是**光标下标**（等于提及末尾），必须落在文本长度之内，超界一律返回 null。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyMention,
  baseName,
  dirName,
  filterHits,
  filterMentions,
  mentionPaths,
  nextMenuForSlash,
  parseMentionAt,
  pendingMentions,
  shouldResetHits,
} from '../src/components/fileMention.ts'

test('行首的 @ 触发提及，query 为空', () => {
  assert.deepEqual(parseMentionAt('@', 1), { query: '', start: 0, end: 1 })
})

test('@ 后面跟着已输入的词，query 就是那一段', () => {
  // '看下 @src/cha' 共 11 字：看0 下1 空2 @3 s4 r5 c6 /7 c8 h9 a10
  assert.deepEqual(parseMentionAt('看下 @src/cha', 11), {
    query: 'src/cha',
    start: 3,
    end: 11,
  })
})

test('@ 必须在行首或空白之后，邮箱不算', () => {
  assert.equal(parseMentionAt('a@b.com', 7), null)
  assert.equal(parseMentionAt('user@host', 9), null)
})

test('中文后面紧跟的 @ 也算触发（用户常这么打）', () => {
  // '看下@src' 共 6 字：看0 下1 @2 s3 r4 c5
  assert.deepEqual(parseMentionAt('看下@src', 6), {
    query: 'src',
    start: 2,
    end: 6,
  })
})

test('@ 与光标之间有空白 → 提及已结束', () => {
  // '@src/a.ts 然后'：光标刻意放在空白之后
  assert.equal(parseMentionAt('@src/a.ts 然后', 11), null)
})

test('光标后面紧贴非空白 → 在句子中间，不该弹菜单', () => {
  assert.equal(parseMentionAt('@src/abc.txt', 4), null)
})

test('多个 @ 时取离光标最近的那个', () => {
  // '@old @new'：@5 o6 l7 d8？不，重新数：@0 o1 l2 d3 空4 @5 n6 e7 w8
  assert.deepEqual(parseMentionAt('@old @new', 9), { query: 'new', start: 5, end: 9 })
})

test('插入路径替换掉 @query，并补一个空格', () => {
  // '看下 @src' 共 7 字：看0 下1 空2 @3 s4 r5 c6
  const mention = parseMentionAt('看下 @src', 7)
  assert.ok(mention)
  const applied = applyMention('看下 @src', mention, 'src/chat.ts')
  assert.equal(applied.text, '看下 @src/chat.ts ')
  assert.equal(applied.caret, applied.text.length)
})

test('路径含空格时用反引号包住，模型不会把它当两个词', () => {
  const mention = parseMentionAt('@Pro', 4)
  assert.ok(mention)
  const applied = applyMention('@Pro', mention, 'Program Files/a.txt')
  assert.equal(applied.text, '@`Program Files/a.txt` ')
})

test('后面已经是空白时不再补空格', () => {
  // '@src 后面'：@0 s1 r2 c3 空4
  const mention = parseMentionAt('@src 后面', 4)
  assert.ok(mention)
  const applied = applyMention('@src 后面', mention, 'src/a.ts')
  assert.equal(applied.text, '@src/a.ts 后面')
})

test('光标之后的内容要原样保留', () => {
  const mention = parseMentionAt('@sr 收尾', 3)
  assert.ok(mention)
  const applied = applyMention('@sr 收尾', mention, 'src/a.ts')
  assert.equal(applied.text, '@src/a.ts 收尾')
})

test('空查询原样返回前 N 条', () => {
  const paths = ['a.ts', 'b.ts', 'c.ts']
  assert.deepEqual(filterMentions(paths, '', 2), ['a.ts', 'b.ts'])
})

test('过滤按子串匹配，文件名命中排在目录命中之前', () => {
  const paths = ['src/chat.ts', 'chat/other.ts', 'doc.md']
  const hits = filterMentions(paths, 'chat')
  assert.deepEqual(hits, ['src/chat.ts', 'chat/other.ts'])
})

test('过滤不区分大小写，且忽略不匹配项', () => {
  const paths = ['SRC/App.tsx', 'lib/x.ts']
  assert.deepEqual(filterMentions(paths, 'app'), ['SRC/App.tsx'])
  assert.deepEqual(filterMentions(paths, 'zzz'), [])
})

test('baseName / dirName 拆分反斜杠与正斜杠', () => {
  assert.equal(baseName('src/app/Chat.tsx'), 'Chat.tsx')
  assert.equal(baseName('src\\app\\Chat.tsx'), 'Chat.tsx')
  assert.equal(baseName('Chat.tsx'), 'Chat.tsx')
  assert.equal(dirName('src\\app\\Chat.tsx'), 'src\\app')
  assert.equal(dirName('src/app/Chat.tsx'), 'src/app')
  assert.equal(dirName('Chat.tsx'), '')
})

test('pendingMentions 只挑出像「没选完」的那几个', () => {
  // 带分隔符或扩展名的算已选好
  assert.deepEqual(pendingMentions('看 @src/a.ts 和 @chat'), ['chat'])
  assert.deepEqual(pendingMentions('没有提及'), [])
})

test('正斜杠 query 也能匹配反斜杠路径（Windows 用户常这么打）', () => {
  const paths = ['src\\chat.ts', 'src\\components\\ChatInput.tsx']
  // 这条是审查抓到的真 bug：不归一的话打 @src/ 会零候选
  assert.equal(filterMentions(paths, 'src/').length, 2)
  assert.equal(filterMentions(paths, 'src/c').length, 2)
  assert.equal(filterMentions(paths, 'src/components').length, 1)
  // 反斜杠照旧
  assert.equal(filterMentions(paths, 'src\\').length, 2)
})

test('选目录后不终结提及，补上反斜杠让用户继续往下选', () => {
  const mention = parseMentionAt('@src', 4)
  assert.ok(mention)
  const applied = applyMention('@src', mention, 'src/components', true)
  assert.equal(applied.text, '@src\\components\\')
  // 提及仍然有效：光标处能继续解析出 query
  const next = parseMentionAt(applied.text, applied.caret)
  assert.ok(next, '目录选完必须还能继续补')
  assert.equal(next.query, 'src\\components\\')
})

test('选文件仍然补空格终结提及（目录和文件行为要区分）', () => {
  const mention = parseMentionAt('@src', 4)
  assert.ok(mention)
  const applied = applyMention('@src', mention, 'src/chat.ts', false)
  assert.equal(applied.text, '@src/chat.ts ')
  assert.equal(parseMentionAt(applied.text, applied.caret), null)
})

test('目录路径已是分隔符结尾时不重复补', () => {
  const mention = parseMentionAt('@src', 4)
  assert.ok(mention)
  const applied = applyMention('@src', mention, 'src\\components\\', true)
  assert.equal(applied.text, '@src\\components\\')
})

test('mentionPaths / filterHits 保留类型信息', () => {
  const hits = [
    { path: 'src\\components', type: 'directory' },
    { path: 'src\\chat.ts', type: 'file' },
  ]
  assert.deepEqual(mentionPaths(hits), ['src\\components', 'src\\chat.ts'])
  const filtered = filterHits(hits, 'chat')
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].type, 'file')
})

/*
 * 回归：@ 文件菜单「出来一瞬间又没了」。
 *
 * 两个独立的坑，都是同一个症状，任一个复发都会让用户看不到候选：
 *   1. 命令菜单的 effect 在「没有 / 前缀」时无条件 setMenu(null)，顺手把 @ 菜单关掉；
 *   2. 光标在同一段提及里移动时无条件清空候选，而搜索 effect 依赖没变、不会重搜。
 */

test('没有 / 前缀时不动 @ 文件菜单', () => {
  assert.equal(nextMenuForSlash('files', null, false), 'files')
})

test('没有 / 前缀时关掉命令/agent 菜单', () => {
  assert.equal(nextMenuForSlash('commands', null, false), null)
  assert.equal(nextMenuForSlash('agents', null, false), null)
})

test('有 / 前缀进入命令菜单', () => {
  assert.equal(nextMenuForSlash(null, 'help', false), 'commands')
})

test('打 /agents 先进命令列表（点了才进 agent 菜单）', () => {
  assert.equal(nextMenuForSlash(null, 'agents', false), 'commands')
})

test('已经在 agent 菜单里时保持不动', () => {
  assert.equal(nextMenuForSlash('agents', 'agents', false), 'agents')
})

test('Esc 关闭后不再自动弹回命令菜单', () => {
  assert.equal(nextMenuForSlash('commands', 'help', true), null)
})

test('首次进入提及要清候选', () => {
  assert.equal(shouldResetHits({ query: '', start: 0, end: 1 }, null), true)
})

test('query 变了要清候选', () => {
  const prev = { query: '', start: 0, end: 1 }
  const next = { query: 's', start: 0, end: 2 }
  assert.equal(shouldResetHits(next, prev), true)
})

test('光标在同一段提及里移动不清候选（否则列表永久空白）', () => {
  const prev = { query: 'src', start: 0, end: 4 }
  const next = { query: 'src', start: 0, end: 4 }
  assert.equal(shouldResetHits(next, prev), false)
})

test('离开提及不触发清空', () => {
  assert.equal(shouldResetHits(null, { query: 'src', start: 0, end: 4 }), false)
})
