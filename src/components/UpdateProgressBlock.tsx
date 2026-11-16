import { taskActive, taskPercent, taskText, type UpdateTask } from './updateProgressFormat'

type Props = {
  task: UpdateTask
  /** 正在检查更新：显示不确定进度条（与下载任务分开，互不覆盖） */
  checking: boolean
}

/**
 * 版本与更新面板里的进度条。
 *
 * 三个阶段各一种形态：
 *   * 检查中 → 不确定进度条（不知道要多久）
 *   * 下载中 → 真实百分比；总量未知时也退成不确定
 *   * 校验 / 重启 → 不确定进度条 + 明确文案
 *
 * 失败不在这里显示（面板的 error 区负责），所以返回 null。
 */
export default function UpdateProgressBlock({ task, checking }: Props) {
  if (task.phase === 'failed') return null

  if (checking && !taskActive(task)) {
    return (
      <div className="update-progress">
        <span className="update-bar indeterminate">
          <span />
        </span>
        <span className="update-progress-text">正在检查更新…</span>
      </div>
    )
  }

  if (!taskActive(task)) return null

  const percent = taskPercent(task)
  return (
    <div className="update-progress" role="status" aria-live="polite">
      <span
        className={`update-bar${percent === null ? ' indeterminate' : ''}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <span style={percent !== null ? { width: `${percent}%` } : undefined} />
      </span>
      <span className="update-progress-text">{taskText(task)}</span>
    </div>
  )
}
