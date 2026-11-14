/**
 * 查看区的文件标签栏：同时打开多个文件时排成一行，点一下切过去。
 *
 * 每条标签独立关闭（中键也能关）；有未保存改动的标签带一个圆点，
 * 关闭前由外层弹确认。标签栏本身不碰文件读写，纯展示 + 回调。
 */

export type FileTabItem = {
  /** 稳定 key：外部文件把 root 算进去，不同目录的同名文件不会互相顶掉。 */
  key: string
  path: string
  /** 外部文件自己的 root；null = 当前工作区 */
  root: string | null
}

type Props = {
  tabs: FileTabItem[]
  activeKey: string | null
  /** 某个标签是否有未保存改动。 */
  dirtyOf: (key: string) => boolean
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onCloseAll: () => void
}

/** 标签上只显示文件名：路径太长会把标签挤爆，完整路径放在 title 里。 */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export default function FileTabs({
  tabs,
  activeKey,
  dirtyOf,
  onSelect,
  onClose,
  onCloseAll,
}: Props) {
  if (tabs.length === 0) return null

  return (
    <div className="file-tabs" role="tablist" aria-label="打开的文件">
      <div className="file-tabs-track">
        {tabs.map((tab) => {
          const active = tab.key === activeKey
          const dirty = dirtyOf(tab.key)
          const full = tab.root ? `${tab.root}\\${tab.path}` : tab.path
          return (
            <div
              key={tab.key}
              className={`file-tab${active ? ' active' : ''}`}
              role="tab"
              aria-selected={active}
              title={full}
              onClick={() => onSelect(tab.key)}
              onAuxClick={(event) => {
                // 中键关闭，和浏览器标签的习惯一致
                if (event.button !== 1) return
                event.preventDefault()
                onClose(tab.key)
              }}
            >
              <span className="file-tab-name">{baseName(tab.path)}</span>
              {dirty ? (
                <span className="file-tab-dirty" aria-label="有未保存的修改">
                  ●
                </span>
              ) : null}
              <button
                type="button"
                className="file-tab-close"
                title="关闭这个文件"
                aria-label="关闭这个文件"
                onClick={(event) => {
                  // 点 × 不能顺带把标签切过去再关
                  event.stopPropagation()
                  onClose(tab.key)
                }}
              />
            </div>
          )
        })}
      </div>
      {tabs.length > 1 ? (
        <button
          type="button"
          className="file-tabs-close-all"
          title="关闭全部文件（有未保存改动会先确认）"
          onClick={onCloseAll}
        >
          全部关闭
        </button>
      ) : null}
    </div>
  )
}
