import type { ShellInfo } from '../api/shells'

/** Shell 列表的纯文本工具（不依赖 React，方便单测）。 */

export function commandSummary(command: string): string {
  const first = command.split(/\r?\n/)[0].trim()
  if (!first) return '(空命令)'
  return first.length > 88 ? `${first.slice(0, 88)}…` : first
}

export function elapsedOf(item: ShellInfo, now: number): string {
  const end = item.time.completed ?? now
  const ms = Math.max(0, end - item.time.started)
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

export function statusText(status: ShellInfo['status']): string {
  if (status === 'running') return '运行中'
  if (status === 'exited') return '已退出'
  if (status === 'timeout') return '超时'
  return '已终止'
}

/**
 * 终端输出里的 ANSI 控制序列：颜色（`ESC[32m`）、光标移动、窗口标题（`ESC]0;…BEL`）。
 *
 * 这些字节在真终端里是看不见的指令，原样塞进 `<pre>` 会显示成 `□[32m` 这种乱码。
 */
const ANSI_ESCAPE =
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

/** 剥掉 ANSI 转义，只留可读文本。 */
export function stripAnsi(text: string): string {
  if (!text) return ''
  return text.replace(ANSI_ESCAPE, '')
}

/**
 * 进度条那种「回到行首覆盖」的 `\r`：真终端只留最后一段，`<pre>` 里却会变成多行。
 *
 * 先按 `\n` 切行，再丢掉每行最后一个 `\r` 之前的内容；行尾的 `\r`（CRLF）直接去掉。
 */
export function collapseCarriageReturns(text: string): string {
  if (!text || !text.includes('\r')) return text
  return text
    .split('\n')
    .map((line) => {
      const tail = line.endsWith('\r') ? line.slice(0, -1) : line
      const cut = tail.lastIndexOf('\r')
      return cut === -1 ? tail : tail.slice(cut + 1)
    })
    .join('\n')
}

/** 渲染终端输出前的清洗：剥 ANSI，再按真终端的语义处理 `\r` 覆盖。 */
export function cleanTerminalOutput(text: string): string {
  return collapseCarriageReturns(stripAnsi(text))
}
