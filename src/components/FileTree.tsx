import { useCallback, useEffect, useState } from 'react'
import { listDir, type FsEntry } from '../api/client'

type Props = {
  root: string
  onOpenFile: (relPath: string) => void
}

/** 这些目录不显示，避免文件树被依赖/产物淹没 */
const HIDDEN = new Set(['node_modules', '.git', 'dist', 'target', '.vite', '.vite-temp', '.cache'])

function baseName(relPath: string): string {
  const trimmed = relPath.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed
}

export default function FileTree({ root, onOpenFile }: Props) {
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<string>('')
  const [error, setError] = useState<string>('')

  const load = useCallback(
    async (rel: string) => {
      setLoading((m) => ({ ...m, [rel]: true }))
      try {
        const entries = await listDir(root, rel || undefined)
        const visible = entries.filter((entry) => !HIDDEN.has(baseName(entry.path)))
        setChildren((m) => ({ ...m, [rel]: visible }))
        setError('')
      } catch (err) {
        setChildren((m) => ({ ...m, [rel]: [] }))
        setError((err as Error).message)
      } finally {
        setLoading((m) => ({ ...m, [rel]: false }))
      }
    },
    [root],
  )

  useEffect(() => {
    setChildren({})
    setExpanded({})
    void load('')
  }, [load])

  function onToggle(entry: FsEntry) {
    const rel = entry.path
    if (!children[rel]) void load(rel)
    setExpanded((m) => ({ ...m, [rel]: !m[rel] }))
  }

  function onPick(entry: FsEntry) {
    setSelected(entry.path)
    onOpenFile(entry.path)
  }

  function renderDir(rel: string, depth: number) {
    const entries = children[rel]
    if (!entries) return null
    if (entries.length === 0 && !loading[rel]) {
      return (
        <div className="tree-empty" style={{ paddingLeft: 12 + depth * 14 }}>
          空文件夹
        </div>
      )
    }
    return (
      <>
        {entries.map((entry) => {
          const isDir = entry.type === 'directory'
          const isOpen = !!expanded[entry.path]
          const isActive = selected === entry.path
          return (
            <div key={entry.path}>
              <div
                className={`tree-item${isActive ? ' active' : ''}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => (isDir ? onToggle(entry) : onPick(entry))}
                title={entry.path}
              >
                <span className="tree-caret">{isDir ? (isOpen ? '▾' : '▸') : ''}</span>
                <span className="tree-icon">{isDir ? '📁' : '📄'}</span>
                <span className="tree-name">{baseName(entry.path)}</span>
              </div>
              {isDir && isOpen ? renderDir(entry.path, depth + 1) : null}
            </div>
          )
        })}
      </>
    )
  }

  return (
    <div className="tree">
      <div className="tree-root" title={root}>
        {root}
      </div>
      {error ? <div className="tree-error">{error}</div> : null}
      {loading[''] ? <div className="tree-empty">加载中…</div> : renderDir('', 0)}
    </div>
  )
}
