import { useCallback, useEffect, useRef, useState } from 'react'
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
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({})
  const [loadedMap, setLoadedMap] = useState<Record<string, boolean>>({})
  const [errorMap, setErrorMap] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string>('')
  // root 变化或组件卸载后，在途请求的结果一律丢弃
  const genRef = useRef(0)

  const load = useCallback(
    async (rel: string) => {
      const gen = genRef.current
      setLoadingMap((m) => ({ ...m, [rel]: true }))
      setErrorMap((m) => {
        if (!(rel in m)) return m
        const next = { ...m }
        delete next[rel]
        return next
      })
      try {
        const entries = await listDir(root, rel || undefined)
        if (gen !== genRef.current) return
        const visible = entries.filter((entry) => !HIDDEN.has(baseName(entry.path)))
        setChildren((m) => ({ ...m, [rel]: visible }))
        setLoadedMap((m) => ({ ...m, [rel]: true }))
      } catch (err) {
        if (gen !== genRef.current) return
        // 失败时不能留下空数组，否则会被当成「空文件夹」
        setChildren((m) => {
          const next = { ...m }
          delete next[rel]
          return next
        })
        setLoadedMap((m) => ({ ...m, [rel]: false }))
        setErrorMap((m) => ({ ...m, [rel]: (err as Error).message }))
      } finally {
        if (gen === genRef.current) setLoadingMap((m) => ({ ...m, [rel]: false }))
      }
    },
    [root],
  )

  useEffect(() => {
    const gen = ++genRef.current
    setChildren({})
    setExpanded({})
    setLoadingMap({})
    setLoadedMap({})
    setErrorMap({})
    void load('')
    return () => {
      if (genRef.current === gen) genRef.current += 1
    }
  }, [load])

  function onToggle(entry: FsEntry) {
    const rel = entry.path
    const isOpen = !!expanded[rel]
    if (!isOpen && !loadedMap[rel] && !loadingMap[rel]) void load(rel)
    setExpanded((m) => ({ ...m, [rel]: !m[rel] }))
  }

  function onPick(entry: FsEntry) {
    setSelected(entry.path)
    onOpenFile(entry.path)
  }

  /** 某个目录的状态行：加载失败（可重试）/ 加载中 / 空目录。有内容时不渲染任何东西。 */
  function renderStatus(rel: string, depth: number) {
    const error = errorMap[rel]
    if (error !== undefined) {
      return (
        <div className="tree-error" style={{ paddingLeft: 12 + depth * 14 }} title={error}>
          <span>加载失败：{error}</span>
          <button
            type="button"
            className="tree-retry"
            onClick={(event) => {
              event.stopPropagation()
              void load(rel)
            }}
          >
            重试
          </button>
        </div>
      )
    }

    const count = children[rel]?.length ?? 0
    if (loadingMap[rel] && count === 0) {
      return (
        <div className="tree-empty" style={{ paddingLeft: 12 + depth * 14 }}>
          加载中…
        </div>
      )
    }
    if (loadedMap[rel] && count === 0) {
      return (
        <div className="tree-empty" style={{ paddingLeft: 12 + depth * 14 }}>
          空文件夹
        </div>
      )
    }
    return null
  }

  function renderDir(rel: string, depth: number) {
    const entries = children[rel]
    if (!entries || entries.length === 0) return renderStatus(rel, depth)
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
      {renderDir('', 0)}
    </div>
  )
}
