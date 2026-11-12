// 消息里文件路径识别的回归测试：node --experimental-strip-types --test scripts/fileLinks.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFilePath, splitTextPaths } from '../src/components/fileLinks.ts'

test('相对/绝对路径都能认出来', () => {
  assert.deepEqual(parseFilePath('src/components/Chat.tsx'), {
    raw: 'src/components/Chat.tsx',
    path: 'src/components/Chat.tsx',
    line: undefined,
  })
  assert.equal(parseFilePath('F:\\proj\\a.py')?.path, 'F:\\proj\\a.py')
  assert.equal(parseFilePath('./docs/x.md')?.path, './docs/x.md')
  assert.equal(parseFilePath('README.md')?.path, 'README.md')
})

test('行号后缀三种写法都解析成 1 基行号', () => {
  assert.equal(parseFilePath('src/a.ts:42')?.line, 42)
  assert.equal(parseFilePath('src/a.ts:42')?.path, 'src/a.ts')
  assert.equal(parseFilePath('src/a.ts:42:7')?.line, 42)
  assert.equal(parseFilePath('src/a.ts#L7')?.line, 7)
  // 盘符里的冒号不能被当成行号
  assert.equal(parseFilePath('F:\\a\\b.ts')?.line, undefined)
})

test('目录、URL、无扩展名、未知扩展名都不认', () => {
  assert.equal(parseFilePath('src/components'), null)
  assert.equal(parseFilePath('https://x.com/a.ts'), null)
  assert.equal(parseFilePath('1/2'), null)
  assert.equal(parseFilePath('foo.bar'), null)
  assert.equal(parseFilePath('src/'), null)
  assert.equal(parseFilePath(''), null)
  assert.equal(parseFilePath(undefined), null)
})

test('尾部标点剥掉，但路径本身保留', () => {
  assert.equal(parseFilePath('src/a.ts,')?.path, 'src/a.ts')
  // 带汉字前缀的整段不是「路径」本身，交给 splitTextPaths 切
  assert.equal(parseFilePath('见（src/a.ts）。'), null)
  const chunks = splitTextPaths('见（src/a.ts）。')
  assert.equal(chunks.filter((c) => c.kind === 'file')[0]?.ref.path, 'src/a.ts')
})

test('一段话里多个路径按原顺序切出来，文字和标点不丢', () => {
  const chunks = splitTextPaths('改一下 src/a.ts 和 src/b.ts，然后看 docs/x.md。')
  const files = chunks.filter((c) => c.kind === 'file').map((c) => c.ref.path)
  assert.deepEqual(files, ['src/a.ts', 'src/b.ts', 'docs/x.md'])

  const rebuilt = chunks.map((c) => c.text).join('')
  assert.equal(rebuilt.includes('改一下'), true)
  assert.equal(rebuilt.includes('，然后看'), true)
  assert.equal(rebuilt.endsWith('。'), true)
})

test('纯文本原样返回一个 text 片段', () => {
  const chunks = splitTextPaths('这里没有路径，只有一句话。')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].kind, 'text')
})

test('带空格的绝对路径整条识别，不被空白切断', () => {
  const chunks = splitTextPaths('打开 C:\\Program Files\\App\\readme.md 看看')
  const files = chunks.filter((c) => c.kind === 'file')
  assert.equal(files.length, 1)
  assert.equal(files[0].ref.path, 'C:\\Program Files\\App\\readme.md')
  assert.equal(files[0].text, 'C:\\Program Files\\App\\readme.md')
})

test('带空格路径紧跟中文：中文不进路径，也不丢字', () => {
  const chunks = splitTextPaths('看 C:\\Program Files\\a.txt，然后改')
  const files = chunks.filter((c) => c.kind === 'file')
  assert.equal(files[0].ref.path, 'C:\\Program Files\\a.txt')
  const rebuilt = chunks.map((c) => c.text).join('')
  assert.equal(rebuilt, '看 C:\\Program Files\\a.txt，然后改')
})

test('带空格路径后面跟英文单词也不会被吞', () => {
  const chunks = splitTextPaths('check C:\\Program Files\\a.txt and then')
  const files = chunks.filter((c) => c.kind === 'file')
  assert.equal(files.length, 1)
  assert.equal(files[0].ref.path, 'C:\\Program Files\\a.txt')
  const rebuilt = chunks.map((c) => c.text).join('')
  assert.equal(rebuilt, 'check C:\\Program Files\\a.txt and then')
})

test('带空格路径的行号后缀仍然生效', () => {
  const chunks = splitTextPaths('C:\\Program Files\\a.txt:12')
  const files = chunks.filter((c) => c.kind === 'file')
  assert.equal(files[0].ref.path, 'C:\\Program Files\\a.txt')
  assert.equal(files[0].ref.line, 12)
})

test('同一行两个带空格路径不会连成一条', () => {
  const chunks = splitTextPaths('C:\\a b\\c.md 和 C:\\d e\\f.md')
  const files = chunks.filter((c) => c.kind === 'file').map((c) => c.ref.path)
  assert.deepEqual(files, ['C:\\a b\\c.md', 'C:\\d e\\f.md'])
})
