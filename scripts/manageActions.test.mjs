// /mcps、/skills 面板的可操作逻辑：状态 → 按钮，技能 → 提示词。
import assert from 'node:assert/strict'
import test from 'node:test'

import { actionsFor, insertPrompt } from '../src/components/manageActions.ts'

test('已连接的服务器只能断开', () => {
  assert.deepEqual(actionsFor('connected'), [{ kind: 'disconnect', label: '断开' }])
  assert.deepEqual(actionsFor('pending'), [{ kind: 'disconnect', label: '断开' }])
})

test('失败与要授权的服务器能重连，也能断开', () => {
  for (const status of ['failed', 'needs_auth', 'unknown']) {
    const actions = actionsFor(status)
    assert.deepEqual(
      actions.map((a) => a.kind),
      ['connect', 'disconnect'],
      status,
    )
    assert.equal(actions[0].label, '重连')
  }
})

test('配置里禁用的服务器给「连接」，不给断开', () => {
  assert.deepEqual(actionsFor('disabled'), [{ kind: 'connect', label: '连接' }])
})

test('插入到对话的提示词带技能名和路径', () => {
  assert.equal(
    insertPrompt({ id: 'ida', name: 'ida', path: 'C:\\s\\ida\\SKILL.md' }),
    '请用 skill 工具加载技能「ida」（C:\\s\\ida\\SKILL.md）',
  )
  assert.equal(insertPrompt({ id: 'x', name: 'x', path: '' }), '请用 skill 工具加载技能「x」')
})
