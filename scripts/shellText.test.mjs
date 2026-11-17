import test from 'node:test'
import assert from 'node:assert/strict'
import { commandSummary, elapsedOf, statusText } from '../src/components/shellText.ts'

function shell(started, completed) {
  return { time: { started, completed } }
}

test('commandSummary: 多行命令只取第一行', () => {
  assert.equal(commandSummary('npm run dev\ncd x && pnpm build'), 'npm run dev')
})

test('commandSummary: 空命令给占位', () => {
  assert.equal(commandSummary('   '), '(空命令)')
})

test('commandSummary: 超长截断到 88 字 + 省略号', () => {
  const text = 'a'.repeat(120)
  const out = commandSummary(text)
  assert.equal(out.length, 89)
  assert.ok(out.endsWith('…'))
})

test('elapsedOf: 跑动中按 now 算，结束后按 completed 算', () => {
  assert.equal(elapsedOf(shell(1000), 1500), '500ms')
  assert.equal(elapsedOf(shell(0), 2500), '2.5s')
  assert.equal(elapsedOf(shell(0, 30_000), 999_999), '30.0s')
})

test('elapsedOf: 超过一分钟显示 m+s', () => {
  assert.equal(elapsedOf(shell(0, 125_000), 0), '2m5s')
})

test('statusText: 四态各自有中文', () => {
  assert.equal(statusText('running'), '运行中')
  assert.equal(statusText('exited'), '已退出')
  assert.equal(statusText('timeout'), '超时')
  assert.equal(statusText('killed'), '已终止')
})
