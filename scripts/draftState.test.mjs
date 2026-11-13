// 输入框草稿的纯逻辑测试：node --experimental-strip-types --test scripts/draftState.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  draftKeyOf,
  draftSignature,
  filesSignature,
  fromStored,
  isBlankDraftKey,
  isDirtyDraft,
  toStored,
} from '../src/components/draftState.ts'

test('有会话时草稿键跟会话走：切标签回来是同一份', () => {
  assert.equal(draftKeyOf('F:\\a', 'ses_1'), 'F:\\a::ses_1')
})

test('没有会话时按标签分开：两个空标签不共用一份草稿', () => {
  const one = draftKeyOf('F:\\a', null, 'tab-1')
  const two = draftKeyOf('F:\\a', null, 'tab-2')
  assert.notEqual(one, two)
  // 没有 tabID（老调用）也不能崩
  assert.match(draftKeyOf('F:\\a', null), /tab:/)
})

test('草稿键带项目：两个项目同名会话不会串', () => {
  assert.notEqual(draftKeyOf('F:\\a', 'ses_1'), draftKeyOf('F:\\b', 'ses_1'))
})

const file = (name, bytes, dataUrl) => ({ name, mime: 'image/png', bytes, dataUrl })

test('附件转盘上形状时去掉 blob 预览地址', () => {
  const stored = toStored([
    { id: 'att-1', name: 'a.png', mime: 'image/png', bytes: 10, dataUrl: 'data:image/png;base64,AA', previewUrl: 'blob:x' },
  ])
  assert.deepEqual(stored, [
    { name: 'a.png', mime: 'image/png', bytes: 10, dataUrl: 'data:image/png;base64,AA' },
  ])
})

test('读回来用 dataUrl 当预览图：重开工作台后图不能是破的', () => {
  const back = fromStored([file('a.png', 10, 'data:image/png;base64,AA')], (i) => `id-${i}`)
  assert.equal(back[0].id, 'id-0')
  assert.equal(back[0].previewUrl, 'data:image/png;base64,AA')
})

test('全空不写盘，只有图或只有字都要写', () => {
  assert.equal(isDirtyDraft('', []), false)
  assert.equal(isDirtyDraft('  \n ', []), false)
  assert.equal(isDirtyDraft('你好', []), true)
  assert.equal(isDirtyDraft('', [file('a.png', 1, 'data:x')]), true)
})

test('内容没变时签名相同，变了就不同（避免重复写盘）', () => {
  const files = [file('a.png', 10, 'data:image/png;base64,AAAA')]
  assert.equal(draftSignature('hi', files), draftSignature('hi', files))
  assert.notEqual(draftSignature('hi', files), draftSignature('hello', files))
  assert.notEqual(draftSignature('hi', []), draftSignature('hi', files))
})

test('附件指纹只看附件：改文字不影响它，换图才变', () => {
  const a = [file('a.png', 10, 'data:image/png;base64,AAAA')]
  const b = [file('a.png', 10, 'data:image/png;base64,BBBB')]
  assert.equal(filesSignature(a), filesSignature([...a]))
  // 长度和名字都相同但内容不同：指纹相同是可接受的（只影响是否重发一次图片）
  assert.equal(filesSignature(a), filesSignature(b))
  assert.notEqual(filesSignature(a), filesSignature([]))
  assert.notEqual(filesSignature(a), filesSignature([file('b.png', 10, a[0].dataUrl)]))
})

test('只有空标签的键才算待迁移：会话之间不能互相搬草稿', () => {
  assert.equal(isBlankDraftKey(draftKeyOf('F:\\a', null, 'tab-1')), true)
  assert.equal(isBlankDraftKey(draftKeyOf('F:\\a', 'ses_1')), false)
  // 真实踩到的 bug：判成前缀相同就搬，导致 A 会话的文字跑进 B 会话
  const a = draftKeyOf('F:\\a', 'ses_1')
  const b = draftKeyOf('F:\\a', 'ses_2')
  assert.equal(a.startsWith('F:\\a::'), true)
  assert.equal(b.startsWith('F:\\a::'), true)
  assert.equal(isBlankDraftKey(a), false)
})
