// 表单（question 工具）答案逻辑的回归测试。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  emptyAnswers,
  formComplete,
  isFieldAnswered,
  toReply,
  toggleChoice,
} from '../src/components/formState.ts'

const single = {
  key: 'q0',
  title: '风格',
  type: 'string',
  options: [
    { value: 'brief', label: '简洁' },
    { value: 'detail', label: '详细' },
  ],
  custom: true,
}
const multi = {
  key: 'q1',
  title: '范围',
  type: 'multiselect',
  options: [
    { value: 'front', label: '前端' },
    { value: 'back', label: '后端' },
  ],
  custom: true,
}
const numberField = { key: 'n', title: '数量', type: 'integer' }
const boolField = { key: 'b', title: '继续？', type: 'boolean' }
const textField = { key: 't', title: '备注', type: 'string' }

test('emptyAnswers：多选初始化为空数组，其余留空', () => {
  const answers = emptyAnswers([single, multi, numberField, boolField])
  assert.deepEqual(answers, { q0: undefined, q1: [], n: undefined, b: undefined })
})

test('单选点击覆盖，多选点击切换', () => {
  assert.equal(toggleChoice(single, undefined, 'brief'), 'brief')
  assert.equal(toggleChoice(single, 'brief', 'detail'), 'detail')
  assert.deepEqual(toggleChoice(multi, [], 'front'), ['front'])
  assert.deepEqual(toggleChoice(multi, ['front'], 'front'), [])
  assert.deepEqual(toggleChoice(multi, ['front'], 'back'), ['front', 'back'])
})

test('完整性：自定义文字也算答案', () => {
  assert.equal(isFieldAnswered(single, undefined), false)
  assert.equal(isFieldAnswered(single, undefined, '随便'), true)
  assert.equal(isFieldAnswered(single, 'brief'), true)
  assert.equal(isFieldAnswered(multi, []), false)
  assert.equal(isFieldAnswered(multi, [], '自定义'), true)
  assert.equal(isFieldAnswered(numberField, 3), true)
  assert.equal(isFieldAnswered(numberField, undefined), false)
  assert.equal(isFieldAnswered(boolField, false), true)
  assert.equal(isFieldAnswered(boolField, undefined), false)
  assert.equal(isFieldAnswered(textField, '  '), false)
  assert.equal(isFieldAnswered(textField, 'x'), true)

  assert.equal(formComplete([single, multi], { q0: 'brief', q1: [] }), false)
  assert.equal(formComplete([single, multi], { q0: 'brief', q1: ['front'] }), true)
  assert.equal(formComplete([single, multi], { q0: 'brief', q1: [] }, { q1: '自定义' }), true)
})

test('toReply：自定义优先、多选合并去重、整数取整', () => {
  const payload = toReply(
    [single, multi, numberField, boolField, textField],
    { q0: 'brief', q1: ['front'], n: 2.9, b: false, t: ' 备注 ' },
    { q0: '自己写的', q1: '自定义' },
  )
  assert.deepEqual(payload, {
    q0: '自己写的',
    q1: ['front', '自定义'],
    n: 2,
    b: false,
    t: '备注',
  })
})

test('toReply：空字段不发送', () => {
  assert.deepEqual(toReply([single, multi], { q0: undefined, q1: [] }), {})
})
