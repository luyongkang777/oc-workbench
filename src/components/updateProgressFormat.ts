/**
 * 工作台自身更新的进度文案与状态合并（纯函数，Node 单测可直接 import）。
 *
 * 单独成文件的原因：更新面板要同时应付三件事 —— 检查、下载、重启 ——
 * 而且**下载进度不能被后来的轮询/重新检查覆盖**。这些判定都做成纯函数，
 * 才能一条条写清楚、也能单测。
 */

import type { UpdateProgress } from '../api/update'

/** 本地任务阶段。`checking` 不在里面：检查是另一条流程，和下载互不干扰。 */
export type UpdateTaskPhase = 'idle' | 'downloading' | 'verifying' | 'restarting' | 'failed'

export type UpdateTask = {
  phase: UpdateTaskPhase
  /** 已下载字节 */
  done: number
  /** 总字节；0 表示未知 */
  total: number
  error: string | null
  /** 要更新到的版本（只用于文案） */
  version: string | null
}

export const IDLE_TASK: UpdateTask = {
  phase: 'idle',
  done: 0,
  total: 0,
  error: null,
  version: null,
}

/** 任务还在进行（下载/校验/重启），此时界面要锁住、也不再自动检查。 */
export function taskActive(task: UpdateTask): boolean {
  return (
    task.phase === 'downloading' || task.phase === 'verifying' || task.phase === 'restarting'
  )
}

/** 任务已经结束且成功（重启中或已完成）——本次进程内不该再检查更新。 */
export function taskSettled(task: UpdateTask): boolean {
  return task.phase === 'restarting'
}

/** `1536` → `1.5 KB`；`2936012` → `2.8 MB`。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 0~100；总量未知时给 null（界面画不确定进度条，不编百分比）。 */
export function taskPercent(task: UpdateTask): number | null {
  if (task.phase === 'restarting') return 100
  if (!Number.isFinite(task.total) || task.total <= 0) return null
  return Math.min(100, Math.max(0, Math.floor((task.done / task.total) * 100)))
}

/** 进度条下面那行字。 */
export function taskText(task: UpdateTask): string {
  if (task.phase === 'downloading') {
    const percent = taskPercent(task)
    if (percent === null) return `下载中 · 已下载 ${formatBytes(task.done)}`
    return `下载中 ${percent}% · ${formatBytes(task.done)} / ${formatBytes(task.total)}`
  }
  if (task.phase === 'verifying') return '下载完成，正在校验 SHA256…'
  if (task.phase === 'restarting') return '更新包已就绪，正在重启到新版本…'
  if (task.phase === 'failed') return task.error ?? '更新失败'
  return ''
}

/**
 * 把外壳的进度合并进本地任务。
 *
 * 三条硬规则：
 *   1. 已经进入 `restarting` / `failed` 的任务**不再被轮询改回去**（这就是
 *      「下载进度不会被重复检测覆盖」的落点）；
 *   2. 已下载字节只增不减：轮询响应可能乱序到达，倒退会让进度条往回跳；
 *   3. 外壳回 `idle`/`checking`（没有任务）时保持本地阶段不变，不要把进度清零。
 */
export function mergeProgress(task: UpdateTask, progress: UpdateProgress): UpdateTask {
  if (task.phase === 'restarting' || task.phase === 'failed') return task

  const done = Math.max(task.done, progress.done)
  const total = progress.total > 0 ? progress.total : task.total

  if (progress.stage === 'failed') {
    return { ...task, phase: 'failed', done, total, error: progress.error ?? '更新失败' }
  }
  if (progress.stage === 'restarting') {
    return { ...task, phase: 'restarting', done, total: total || done, error: null }
  }
  if (progress.stage === 'verifying') {
    return { ...task, phase: 'verifying', done, total, error: null }
  }
  if (progress.stage === 'downloading') {
    return { ...task, phase: 'downloading', done, total, error: null }
  }
  // idle / checking：外壳那边还没开始下载，保持本地状态（可能是刚点下去还没轮到）
  return { ...task, done, total }
}

/**
 * 后端是否仍在更新。
 *
 * 用在「apply 的 HTTP 请求失败/超时」之后：客户端断开不代表后端停了，
 * 这时要按真实进度决定是继续跟随还是报失败。
 */
export function backendStillRunning(progress: UpdateProgress | null): boolean {
  if (!progress) return false
  if (progress.stage === 'restarting') return true
  return progress.active && (progress.stage === 'downloading' || progress.stage === 'verifying')
}

/** 更新按钮上的字。 */
export function applyButtonText(task: UpdateTask): string {
  if (task.phase === 'downloading') {
    const percent = taskPercent(task)
    return percent === null ? '下载中…' : `下载中 ${percent}%`
  }
  if (task.phase === 'verifying') return '校验中…'
  if (task.phase === 'restarting') return '重启中…'
  if (task.phase === 'failed') return '重试更新'
  return '立即更新'
}
