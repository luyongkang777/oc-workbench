import type { CliStatus } from '../api/cli'

/**
 * OpenCode CLI 在界面上的文案逻辑。
 *
 * 单独放一层纯函数：顶栏胶囊和更新面板都要用同一套判断，而这两处都不该
 * 各写一遍「装了没装、要不要更新」的分支（很容易改一处漏一处）。
 */

/** 字节数 → 人话（1 位小数足够看进度）。 */
export function formatBytes(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 顶栏胶囊里的 CLI 标记。状态还没拿到时返回 null（不占位，避免闪一下）。 */
export function cliTag(status: CliStatus | null): string | null {
  if (!status) return null
  if (!status.installed) return status.supported ? 'oc 未装' : 'oc 缺失'
  return status.version ? `oc ${status.version}` : 'oc ?'
}

/** 胶囊要不要高亮：没装，或者本机版本落后 / 不是 v2。 */
export function cliFresh(status: CliStatus | null): boolean {
  if (!status) return false
  return status.newer
}

/** 面板里的状态文案。 */
export function cliStateLabel(status: CliStatus | null): string {
  if (!status) return '读取中…'
  if (!status.installed) return status.supported ? '未安装' : '未安装（本平台不支持自动安装）'
  if (!status.version) return '已安装，版本读取失败'
  return `v${status.version}`
}

/**
 * 「版本读取失败」时给人看的原因，正常情况返回 null。
 *
 * 状态行那句「已安装，版本读取失败」不带原因，用户没法判断是装错版本、
 * 还是路径定位到了跑不起来的包装脚本。这里只挑最常见的一种给出可操作的话，
 * 其余原样透出后端原因（不替它编）。
 */
export function cliVersionHint(status: CliStatus | null): string | null {
  if (!status || !status.installed || status.version) return null
  const reason = status.error ?? ''
  if (/193|Win32/i.test(reason)) {
    return '定位到的不是可执行文件（可能是 npm 的脚本包装），点下面的按钮装成 .exe 即可'
  }
  return reason || null
}

/** 主按钮能不能点。装/更新中、或者当前平台不支持时都不能点。 */
export function cliCanInstall(status: CliStatus | null): boolean {
  if (!status) return false
  if (!status.supported || status.busy) return false
  return status.newer
}

/** 主按钮文案。 */
export function cliActionLabel(status: CliStatus | null): string {
  if (!status) return '安装'
  if (status.busy) return '处理中…'
  if (!status.supported) return '仅 Windows 支持'
  if (!status.installed) return '下载并安装'
  if (status.newer) return status.latest ? `更新到 v${status.latest}` : '更新'
  return '已是最新'
}

/**
 * 下载进度。`total` 为 0（发布列表没给大小）时只给阶段文案、不给百分比，
 * 免得画一条永远停在 0 的进度条。
 */
export function cliProgress(status: CliStatus | null): { text: string; percent: number | null } | null {
  if (!status || !status.busy) return null
  if (status.total > 0) {
    const percent = Math.min(100, Math.max(0, Math.round((status.done / status.total) * 100)))
    return {
      percent,
      text: `${status.phase || '下载中'} · ${percent}% · ${formatBytes(status.done)} / ${formatBytes(status.total)}`,
    }
  }
  return { percent: null, text: status.phase || '处理中…' }
}
