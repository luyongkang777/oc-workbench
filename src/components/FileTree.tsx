import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listDirLocal, type LocalEntry } from '../api/localfs'

type Props = {
  root: string
  onOpenFile: (relPath: string) => void
  /** 外部刷新信号：变化时重新拉取所有已加载目录（保留展开状态）。 */
  refreshSeq?: number
}

/** 这些目录不显示，避免文件树被依赖/产物淹没 */
const HIDDEN = new Set(['node_modules', '.git', 'dist', 'target', '.vite', '.vite-temp', '.cache'])
/** 行高与 panels.css 的 .tree-row 保持一致。 */
const ROW_HEIGHT = 24
const OVERSCAN_ROWS = 10

function baseName(relPath: string): string {
  const trimmed = relPath.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed
}

type Row = {
  key: string
  path: string
  depth: number
  kind: 'dir' | 'file' | 'status'
  label: string
  isOpen?: boolean
  error?: string
}

type TreeState = {
  children: Record<string, LocalEntry[]>
  expanded: Record<string, boolean>
  loading: Record<string, boolean>
  loaded: Record<string, boolean>
  errors: Record<string, string>
}

const EMPTY_STATE: TreeState = { children: {}, expanded: {}, loading: {}, loaded: {}, errors: {} }

/** 把「已展开的目录树」拍平成行列表：虚拟滚动只要这个一维数组。 */
function buildRows(state: TreeState): Row[] {
  const rows: Row[] = []
  const walk = (rel: string, depth: number) => {
    const error = state.errors[rel]
    if (error !== undefined) {
      rows.push({ key: `status:${rel}`, path: rel, depth, kind: 'status', label: `加载失败：${error}`, error })
      return
    }
    const entries = state.children[rel]
    if (!entries) {
      if (state.loading[rel] || !state.loaded[rel]) {
        rows.push({ key: `status:${rel}`, path: rel, depth, kind: 'status', label: '加载中…' })
      }
      return
    }
    if (entries.length === 0) {
      rows.push({ key: `status-empty:${rel}`, path: rel, depth, kind: 'status', label: '空文件夹' })
      return
    }
    for (const entry of entries) {
      const isDir = entry.type === 'directory'
      rows.push({
        key: entry.path,
        path: entry.path,
        depth,
        kind: isDir ? 'dir' : 'file',
        label: baseName(entry.path),
        isOpen: isDir ? !!state.expanded[entry.path] : undefined,
      })
      if (isDir && state.expanded[entry.path]) walk(entry.path, depth + 1)
    }
  }
  walk('', 0)
  return rows
}

/**
 * 文件树：目录懒加载 + 行虚拟化。
 *
 * 以前每个节点都是一个真实 DOM，展开几十个目录、上千个文件后，每次点选都要
 * 重排上千个节点；现在只渲染视口里的 ~40 行，扁平化本身是 O(已展开节点) 的纯数组操作。
 */
export default function FileTree({ root, onOpenFile, refreshSeq = 0 }: Props) {
  const [state, setState] = useState<TreeState>(EMPTY_STATE)
  const [selected, setSelected] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(480)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const rafRef = useRef(0)
  // root 变化或组件卸载后，在途请求的结果一律丢弃
  const genRef = useRef(0)

  const load = useCallback(
    async (rel: string) => {
      const gen = genRef.current
      setState((prev) => ({
        ...prev,
        loading: { ...prev.loading, [rel]: true },
        errors: withoutKey(prev.errors, rel),
      }))
      try {
        const entries = await listDirLocal(root, rel)
        if (gen !== genRef.current) return
        const visible = entries.filter((entry) => !HIDDEN.has(baseName(entry.path)))
        setState((prev) => ({
          ...prev,
          children: { ...prev.children, [rel]: visible },
          loaded: { ...prev.loaded, [rel]: true },
        }))
      } catch (err) {
        if (gen !== genRef.current) return
        setState((prev) => ({
          ...prev,
          // 失败时不能留下空数组，否则会被当成「空文件夹」
          children: withoutKey(prev.children, rel),
          loaded: { ...prev.loaded, [rel]: false },
          errors: { ...prev.errors, [rel]: (err as Error).message },
        }))
      } finally {
        if (gen === genRef.current) {
          setState((prev) => ({ ...prev, loading: { ...prev.loading, [rel]: false } }))
        }
      }
    },
    [root],
  )

  useEffect(() => {
    const gen = ++genRef.current
    setSelected('')
    setState(EMPTY_STATE)
    setScrollTop(0)
    void load('')
    return () => {
      if (genRef.current === gen) genRef.current += 1
    }
  }, [load])

  const attachScroll = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    scrollRef.current = node
    if (!node) return
    const update = () => setViewportHeight(node.clientHeight || 480)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    observerRef.current = observer
  }, [])

  useEffect(
    () => () => {
      observerRef.current?.disconnect()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  const onScroll = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop)
    })
  }, [])

  // 已展开、但还没有 children/loading/error 的目录：补加载。
  useEffect(() => {
    for (const [rel, open] of Object.entries(state.expanded)) {
      if (!open) continue
      if (state.children[rel] || state.loading[rel] || state.errors[rel]) continue
      void load(rel)
    }
  }, [state.expanded, state.children, state.loading, state.errors, load])

  // 外部刷新：重新拉取所有已加载过的目录（保留展开/选中状态）。
  const childrenRef = useRef(state.children)
  childrenRef.current = state.children
  useEffect(() => {
    if (!refreshSeq) return
    for (const rel of Object.keys(childrenRef.current)) void load(rel)
  }, [refreshSeq, load])

  const rows = useMemo(() => buildRows(state), [state])

  // 更新函数必须纯：只翻转展开状态，真正的加载交给下面按 state 派发的 effect。
  const activate = useCallback(
    (rel: string, isDir: boolean) => {
      if (!isDir) {
        setSelected(rel)
        onOpenFile(rel)
        return
      }
      setState((prev) => ({
        ...prev,
        expanded: { ...prev.expanded, [rel]: !prev.expanded[rel] },
      }))
    },
    [onOpenFile],
  )

  const retry = useCallback((rel: string) => void load(rel), [load])

  const maxFirst = Math.max(0, rows.length - 1)
  const first = Math.min(maxFirst, Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS))
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN_ROWS)

  // 折叠/切目录后行数变短：滚出范围的 scrollTop 要主动收回，否则会渲染出空列表。
  useEffect(() => {
    const max = Math.max(0, rows.length * ROW_HEIGHT - viewportHeight)
    if (scrollTop <= max) return
    setScrollTop(max)
    if (scrollRef.current) scrollRef.current.scrollTop = max
  }, [rows.length, viewportHeight, scrollTop])

  return (
    <div className="tree">
      <div className="tree-root" title={root}>
        {root}
      </div>
      <div className="tree-scroll" ref={attachScroll} onScroll={onScroll}>
        <div className="tree-rows" style={{ height: rows.length * ROW_HEIGHT }}>
          {rows.slice(first, last).map((row, index) => (
            <div
              key={row.key}
              className={`tree-row${selected === row.path ? ' active' : ''}`}
              style={{ top: (first + index) * ROW_HEIGHT, paddingLeft: 8 + row.depth * 14 }}
              title={row.path}
              onClick={() => {
                if (row.kind !== 'status') activate(row.path, row.kind === 'dir')
              }}
            >
              {row.kind === 'status' ? (
                <>
                  <span className="tree-status">{row.label}</span>
                  {row.error !== undefined ? (
                    <button
                      type="button"
                      className="tree-retry"
                      onClick={(event) => {
                        event.stopPropagation()
                        retry(row.path)
                      }}
                    >
                      重试
                    </button>
                  ) : null}
                </>
              ) : (
                <>
                  <span className="tree-caret">
                    {row.kind === 'dir' ? (row.isOpen ? '▾' : '▸') : ''}
                  </span>
                  <span className="tree-icon">{row.kind === 'dir' ? '📁' : '📄'}</span>
                  <span className="tree-name">{row.label}</span>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}
