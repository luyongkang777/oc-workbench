// 真实渲染验证：用真实失败数据走一遍 groupTurns + describeFailure，看最终文案。
// 这是「端到端」层：不验证 CSS，只验证「截图里那条英文错误」会变成什么中文。
import assert from 'node:assert/strict'
import test from 'node:test'

import { describeFailure } from '../src/components/failureText.ts'
import { groupTurns } from '../src/components/turns.ts'

/** 照抄服务端 idle 消息的真实形状（opencode 2.3 实测）。 */
function idleFailed(error, id = 'msg_1') {
  return {
    id,
    type: 'idle',
    sessionID: 'ses_x',
    outcome: 'failed',
    error,
    time: { created: 1795161572000 },
  }
}

function userMessage(text, id = 'msg_0') {
  return {
    id,
    type: 'user',
    sessionID: 'ses_x',
    content: [{ type: 'text', text }],
    time: { created: 1795161571000 },
  }
}

test('截图里那条英文错误 → 界面显示中文说明（端到端）', () => {
  // 用户提问 + 服务端失败（就是截图里的那条）
  // groupTurns 吃的是「服务端顺序」（新的在前），所以 idle 要排在 user 前面
  const turns = groupTurns([
    idleFailed({
      type: 'provider.free-limit',
      message:
        "Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.",
      status: 429,
      retryAfterMs: 59_181_000,
    }),
    userMessage('帮我改一下这个函数'),
  ])

  assert.equal(turns.length, 1)
  const failure = turns[0].failure
  assert.ok(failure, '这一轮应该挂上失败说明')
  // retryAfterMs 必须从 idle 消息一路带到 turn.failure（用于「约 16 小时后恢复」）
  assert.equal(failure.retryAfterMs, 59_181_000)

  const text = describeFailure(failure)
  console.log('\n界面实际显示：')
  console.log('  标题：' + text.title)
  console.log('  做法：' + text.hint)
  console.log('  原文：' + text.raw.slice(0, 60) + '…')
  console.log('')

  assert.equal(text.kind, 'free-limit')
  // 绝不能还显示英文原文当主文案
  assert.doesNotMatch(text.title, /Free usage limit/)
  assert.match(text.title, /免费/)
  assert.match(text.hint, /约 16 小时/)
  assert.match(text.hint, /换一个模型/)
})

test('普通 429 限流仍然说「稍等几秒」，不跟免费额度混为一谈', () => {
  const turns = groupTurns([
    idleFailed({ type: 'provider.rate-limit', message: 'Too many requests', status: 429 }),
    userMessage('hi'),
  ])
  const text = describeFailure(turns[0].failure)
  assert.equal(text.kind, 'rate-limit')
  assert.match(text.hint, /稍等/)
  assert.doesNotMatch(text.hint, /小时/)
})

test('失败后又有正常回复时，说明要撤掉（不能同时显示失败和回答）', () => {
  // 注意 groupTurns 内部会 reverse()：它接收的是「服务端顺序」（新的在前）。
  // 第一版按时间正序传进来，顺序整个反了，测出来的是另一回事。
  const turns = groupTurns([
    {
      id: 'msg_2',
      type: 'assistant',
      sessionID: 'ses_x',
      content: [{ type: 'text', text: '这是迟到的正常回复' }],
      time: { created: 1795161573000, completed: 1795161574000 },
    },
    idleFailed({ type: 'provider.rate-limit', message: 'x', status: 429 }),
    userMessage('hi'),
  ])
  assert.equal(turns[0].failure, undefined, '有正常回复后不该再挂失败')
})
