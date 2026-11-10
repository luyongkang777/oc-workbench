// 附件规则 / 本地图片路径的回归测试：node --experimental-strip-types --test scripts/attachments.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  dataUrlBytes,
  describeSkipped,
  isImageFile,
  isImageMime,
  planAttachments,
  MAX_ATTACHMENTS,
  MAX_SINGLE_BYTES,
  MAX_TOTAL_DATA_URL,
} from '../src/components/attachments.ts'
import { localPathOf } from '../src/components/localPath.ts'

test('dataUrlBytes 按 base64 长度算实际字节数', () => {
  const b64 = Buffer.from('hello world').toString('base64')
  assert.equal(dataUrlBytes(`data:text/plain;base64,${b64}`), 11)
  assert.equal(dataUrlBytes('not-a-data-url'), 0)
})

test('图片判定优先信 mime，没有就看扩展名', () => {
  assert.equal(isImageMime('image/png'), true)
  assert.equal(isImageMime('image/svg+xml'), true)
  assert.equal(isImageMime('application/pdf'), false)
  assert.equal(isImageFile({ mime: 'image/jpeg' }), true)
  assert.equal(isImageFile({ name: 'shot.PNG' }), true)
  assert.equal(isImageFile({ name: 'note.md', mime: 'text/markdown' }), false)
})

test('超过数量上限的文件被跳过，其余照常加入', () => {
  const existing = Array.from({ length: MAX_ATTACHMENTS - 1 }, (_, i) => ({
    name: `a${i}.png`,
    bytes: 1000,
  }))
  const plan = planAttachments(existing, [
    { name: 'ok.png', bytes: 1000 },
    { name: 'extra.png', bytes: 1000 },
  ])
  assert.deepEqual(plan.accept, [0])
  assert.equal(plan.skipped.length, 1)
  assert.match(plan.skipped[0].reason, /最多/)
})

test('单张超 6MB 和总量超 9MB 都拒绝，且不因为一个坏文件拒掉整批', () => {
  const plan = planAttachments(
    [],
    [
      { name: 'huge.png', bytes: MAX_SINGLE_BYTES + 1 },
      { name: 'fine.png', bytes: 200 * 1024 },
      { name: 'total.png', bytes: Math.floor((MAX_TOTAL_DATA_URL * 3) / 4) },
    ],
  )
  assert.deepEqual(plan.accept, [1])
  assert.equal(plan.skipped.length, 2)
  assert.match(plan.notice ?? '', /未加入/)
})

test('describeSkipped 只有一个时直接说文件名和原因', () => {
  assert.equal(describeSkipped([]), '')
  assert.equal(
    describeSkipped([{ name: 'a.png', reason: '单张超过 6 MB' }]),
    'a.png 未加入：单张超过 6 MB',
  )
})

test('本地图片路径：相对路径原样，绝对路径裁成相对工作区', () => {
  const root = 'F:\\opencode\\workbench'
  assert.equal(localPathOf(root, './docs/a.png'), 'docs/a.png')
  assert.equal(localPathOf(root, 'docs\\a.png'), 'docs/a.png')
  assert.equal(localPathOf(root, 'F:\\opencode\\workbench\\shots\\a.png'), 'shots/a.png')
  assert.equal(localPathOf(root, 'F:/opencode/workbench/shots/a.png'), 'shots/a.png')
  assert.equal(localPathOf(root, '/f/opencode/workbench/shots/a.png'), 'shots/a.png')
  assert.equal(localPathOf(root, 'file:///F:/opencode/workbench/shots/a.png'), 'shots/a.png')
})

test('本地图片路径：远程、data URL、越界绝对路径都返回 null', () => {
  const root = 'F:\\opencode\\workbench'
  assert.equal(localPathOf(root, 'https://x.com/a.png'), null)
  assert.equal(localPathOf(root, 'data:image/png;base64,AAAA'), null)
  assert.equal(localPathOf(root, 'C:\\Windows\\a.png'), null)
  assert.equal(localPathOf(root, '//host/share/a.png'), null)
  assert.equal(localPathOf(root, ''), null)
  assert.equal(localPathOf(root, undefined), null)
})
