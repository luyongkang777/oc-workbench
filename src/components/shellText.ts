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
