import { Icon } from './Icon'
import type { Project } from './projectList'

/**
 * 没有打开任何项目时的首页。
 *
 * 为什么需要它：以前启动时会把一个写死的开发目录当成默认工作区，
 * 换台电脑那个目录根本不存在，界面直接是一棵报错的空树。
 * 现在没有任何记录就停在这一页，让用户先选一个真实存在的文件夹。
 */
export default function WelcomePane({
  projects,
  connected,
  reason,
  onPick,
  onOpen,
  onRemove,
}: {
  projects: Project[]
  connected: boolean
  /** 后端没连上时的具体原因（外壳给的原文，例如「找不到 opencode」）。 */
  reason?: string | null
  onPick: () => void
  onOpen: (path: string) => void
  onRemove: (path: string) => void
}) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-logo">
          <Icon name="logo" size={40} />
        </div>
        <h1>OpenCode 工作台</h1>
        <p className="welcome-sub">
          选一个文件夹作为工作区：左边看文件、中间读代码、右边和 AI 对话。
        </p>
        <button type="button" className="welcome-primary" onClick={onPick}>
          打开文件夹
        </button>
        <p className="welcome-hint">
          也可以把文件夹直接拖到窗口图标上，或用「＋」在顶栏随时加一个项目。
        </p>

        {projects.length > 0 ? (
          <div className="welcome-recent">
            <div className="welcome-recent-title">最近打开</div>
            <ul>
              {projects.slice(0, 8).map((project) => (
                <li key={project.path}>
                  <button type="button" className="welcome-recent-open" onClick={() => onOpen(project.path)}>
                    <span className="welcome-recent-name">{project.name}</span>
                    <span className="welcome-recent-path" title={project.path}>
                      {project.path}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="welcome-recent-remove"
                    title="从列表移除（不动磁盘）"
                    onClick={() => onRemove(project.path)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {connected ? null : (
          <div className="welcome-warn" role="status">
            <div className="welcome-warn-title">后端未连接</div>
            <div className="welcome-warn-reason">{reason ?? '正在等待 opencode 服务…'}</div>
            <div className="welcome-warn-hint">
              装好 opencode 后会自动连上，也可以点右上角「重试」立刻再试一次。
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
