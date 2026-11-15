import { useCallback, useEffect, useRef, useState } from 'react'

import { breadcrumbs, createFolder, listDirectory, type BrowseEntry } from '../api/browse'

/**
 * 选项目目录的浏览面板（手机 / 浏览器用）。
 *
 * 以前手机上是 `window.prompt('输入文件夹路径')` —— 得自己背路径，基本没法用。
 * 这里给一个「盘符 → 逐级点进去」的列表，还能就地新建文件夹当新项目。
 *
 * exe 里不走这个面板：外壳会弹原生文件夹对话框（`oc:pick-folder`）。
 */
type Props = {
  open: boolean
  /** 打开时先落到哪个目录（通常是当前项目根）。 */
  initialPath?: string
  onClose: () => void
  onPick: (path: string) => void
}

const MAX_CRUMBS = 6

export default function FolderPicker({ open, initialPath, onClose, onPick }: Props) {
  const [path, setPath] = useState('')
  const [parent, setParent] = useState('')
  const [drives, setDrives] = useState<BrowseEntry[]>([])
  const [dirs, setDirs] = useState<BrowseEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  // 连点两个目录时，先发的请求可能后回来；用序号只认最后一次点击的结果。
  const loadSeqRef = useRef(0)

  const load = useCallback(async (target: string) => {
    const seq = ++loadSeqRef.current
    setLoading(true)
    setError(null)
    const result = await listDirectory(target)
    if (seq !== loadSeqRef.current) return
    setLoading(false)
    if (!result.ok) {
      setError(result.error)
      // 目标目录打不开（被删/没权限）时退回盘符列表，别把人卡死在空白页
      if (target) {
        const fallback = await listDirectory('')
        if (seq === loadSeqRef.current && fallback.ok) applyListing(fallback.listing)
      }
      return
    }
    applyListing(result.listing)
  }, [])

  function applyListing(listing: {
    path: string
    parent: string
    drives: BrowseEntry[]
    dirs: BrowseEntry[]
    truncated: boolean
  }) {
    setPath(listing.path)
    setParent(listing.parent)
    setDrives(listing.drives)
    setDirs(listing.dirs)
    setTruncated(listing.truncated)
  }

  useEffect(() => {
    if (!open) return
    setNewName('')
    setError(null)
    void load(initialPath ?? '')
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, initialPath, load, onClose])

  async function handleCreate() {
    const name = newName.trim()
    if (!name) {
      setError('先填一个文件夹名')
      return
    }
    if (!path) {
      setError('先在某个盘里选一个位置')
      return
    }
    setCreating(true)
    setError(null)
    const result = await createFolder(path, name)
    setCreating(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    // 新建即选中：用户点「新建文件夹」多半就是为了拿它当项目目录
    setNewName('')
    onPick(result.path)
  }

  const crumbs = breadcrumbs(path)
  const shownCrumbs = crumbs.length > MAX_CRUMBS ? crumbs.slice(-MAX_CRUMBS) : crumbs
  const entries = path ? dirs : drives

  return (
    <>
      {open ? <div className="folder-mask" onMouseDown={onClose} /> : null}
      <div className={`folder-dialog${open ? ' open' : ''}`} aria-hidden={!open} role="dialog" aria-label="选择项目目录">
        <div className="folder-head">
          <span className="folder-title">选择项目目录</span>
          <button type="button" className="folder-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="folder-path">
          <button
            type="button"
            className="folder-up"
            onClick={() => void load(parent)}
            disabled={loading || (!parent && !path)}
            title={parent ? `上一级：${parent}` : '已经是根目录'}
          >
            ↑
          </button>
          <div className="folder-crumbs">
            <button type="button" className="folder-crumb" onClick={() => void load('')} title="显示所有盘">
              计算机
            </button>
            {crumbs.length > MAX_CRUMBS ? <span className="folder-crumb-gap">…</span> : null}
            {shownCrumbs.map((crumb) => (
              <span key={crumb.path} className="folder-crumb-wrap">
                <span className="folder-crumb-sep">›</span>
                <button
                  type="button"
                  className="folder-crumb"
                  onClick={() => void load(crumb.path)}
                  title={crumb.path}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </div>
        </div>

        <div className="folder-list" data-folder-list>
          {loading ? <p className="folder-hint">读取中…</p> : null}
          {!loading && entries.length === 0 ? <p className="folder-hint">这里没有子文件夹</p> : null}
          {entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="folder-row"
              onClick={() => void load(entry.path)}
              title={entry.path}
            >
              <span className="folder-icon" aria-hidden="true">
                🗂
              </span>
              <span className="folder-name">{entry.name}</span>
            </button>
          ))}
          {truncated ? <p className="folder-hint">子文件夹太多，只显示了前 1000 个</p> : null}
        </div>

        <div className="folder-foot">
          <div className="folder-new">
            <input
              className="folder-input"
              type="text"
              placeholder="新建文件夹（当作新项目）"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleCreate()
              }}
              spellCheck={false}
            />
            <button
              type="button"
              className="folder-btn ghost"
              onClick={() => void handleCreate()}
              disabled={creating || !path}
            >
              {creating ? '创建中…' : '新建'}
            </button>
          </div>
          {error ? <p className="folder-msg">{error}</p> : null}
          <button
            type="button"
            className="folder-btn primary"
            onClick={() => onPick(path)}
            disabled={!path || loading}
            title={path || '请先进入一个文件夹'}
          >
            用这个目录
          </button>
        </div>
      </div>
    </>
  )
}
