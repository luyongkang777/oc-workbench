import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanTerminalOutput, commandSummary, elapsedOf, statusText, stripAnsi } from '../src/components/shellText.ts'

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

test('stripAnsi: 剥掉颜色、光标与窗口标题，纯文本不动', () => {
  assert.equal(stripAnsi('\u001b[32m✓\u001b[0m done'), '✓ done')
  assert.equal(stripAnsi('\u001b[2mVITE\u001b[22m v6.4.5'), 'VITE v6.4.5')
  assert.equal(stripAnsi('\u001b]0;title\u0007text'), 'text')
  assert.equal(stripAnsi('line\u001b[1Aup'), 'lineup')
  assert.equal(stripAnsi('纯文本\n不变'), '纯文本\n不变')
  assert.equal(stripAnsi(''), '')
})

test('cleanTerminalOutput: 进度条的回车只留最后一段，CRLF 不受影响', () => {
  assert.equal(cleanTerminalOutput('10%\r50%\r100%\n'), '100%\n')
  assert.equal(cleanTerminalOutput('a\rb\r\nc'), 'b\nc')
  assert.equal(cleanTerminalOutput('CRLF\r\n保留'), 'CRLF\n保留')
  assert.equal(cleanTerminalOutput('\u001b[32mok\u001b[0m\rdone'), 'done')
})
