/**
 * 项目标签：平铺在顶栏，和「审查」同一行，点一下就切过去。
 *
 * 「＋」必须始终可见：它放在滚动区外面（标签多了只有标签区滚动），
 * 项目为空时直接显示带文字的「打开文件夹」，不然只剩一个淡图标等于没有。
 *
 * 每个标签前面有一颗状态灯：AI 这个项目里正在生成就呼吸黄，跑完常亮绿。
 * 灯的状态来自 App 的 useProjectRunning（跨项目），不是当前会话一个布尔值 ——
 * 切走标签以后原来那个项目仍然要亮着。
 */

import { Icon } from './Icon'
import { normKey, type Project } from './projectList'

type Props = {
  projects: Project[]
  /** 当前项目路径 */
  active: string
  /** 正在生成的项目（normKey 集合） */
  running: Set<string>
  /** 服务端连上了没：没连上时灯不做「空闲」承诺 */
  connected: boolean
  onSwitch: (path: string) => void
  onRemove: (path: string) => void
  onAdd: () => void
}

export default function ProjectTabs({
  projects,
  active,
  running,
  connected,
  onSwitch,
  onRemove,
  onAdd,
}: Props) {
  const activeKey = normKey(active)
  const empty = projects.length === 0

  return (
    <div className="project-strip">
      {empty ? null : (
        <div className="project-tabs" role="tablist" aria-label="项目">
          {projects.map((project) => {
            const isActive = normKey(project.path) === activeKey
            const busy = running.has(normKey(project.path))
            const light = busy ? 'running' : connected ? 'idle' : 'unknown'
            return (
              <div
                key={project.path}
                className={`project-tab${isActive ? ' active' : ''}`}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                title={project.path}
                onClick={() => onSwitch(project.path)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSwitch(project.path)
                  }
                }}
              >
                <span
                  className={`project-tab-light ${light}`}
                  title={busy ? 'AI 正在生成…' : connected ? '空闲' : '未连接'}
                  aria-hidden="true"
                />
                <span className="project-tab-name">{project.name}</span>
                <button
                  type="button"
                  className="project-tab-del"
                  title="从列表移除（不会删磁盘上的文件）"
                  aria-label={`移除 ${project.name}`}
                  onClick={(event) => {
                    // 别让点关闭顺带切过去
                    event.stopPropagation()
                    onRemove(project.path)
                  }}
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <button
        type="button"
        className={`project-tab-add${empty ? ' wide' : ''}`}
        onClick={onAdd}
        title="打开文件夹作为新项目"
      >
        <Icon name="plus" size={13} />
        {empty ? <span className="project-tab-add-label">打开文件夹</span> : null}
      </button>
    </div>
  )
}
