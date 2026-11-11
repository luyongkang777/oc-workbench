import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createFileLocal,
  deleteLocal,
  listDirLocal,
  mkdirLocal,
  renameLocal,
  type LocalEntry,
} from '../api/localfs'

type Props = {
  root: string
  onOpenFile: (relPath: string, line?: number, edit?: boolean) => void
  /** 外部刷新信号：变化时重新拉取所有已加载目录（保留展开状态）。 */
  refreshSeq?: number
  /** 当前打开的文件：删除/重命名影响它时要先确认未保存改动。 */
  activePath?: string | null
  /** 编辑器是否有未保存改动（App 里的 ref 读值函数）。 */
  isDirty?: () => boolean
  /** 文件/文件夹被删除（App 用它关掉正在看的文件）。 */
  onPathRemoved?: (relPath: string) => void
  /** 被重命名（App 用它把打开中的文件路径换到新名字）。 */
  onPathRenamed?: (from: string, to: string) => void
}

/** 新建文件时的常用类型：只负责把扩展名补到文件名后面。 */
const CODE_KINDS: { ext: string; label: string }[] = [
  { ext: '', label: '自定义（按输入的名字）' },
  { ext: '.c', label: 'C 源文件 (.c)' },
  { ext: '.cpp', label: 'C++ 源文件 (.cpp)' },
  { ext: '.cc', label: 'C++ 源文件 (.cc)' },
  { ext: '.cxx', label: 'C++ 源文件 (.cxx)' },
  { ext: '.h', label: 'C 头文件 (.h)' },
  { ext: '.hpp', label: 'C++ 头文件 (.hpp)' },
  { ext: '.txt', label: '文本 (.txt)' },
  { ext: '.md', label: 'Markdown (.md)' },
  { ext: '.json', label: 'JSON (.json)' },
  { ext: '.py', label: 'Python (.py)' },
  { ext: '.js', label: 'JavaScript (.js)' },
  { ext: '.ts', label: 'TypeScript (.ts)' },
  { ext: '.html', label: 'HTML (.html)' },
  { ext: '.css', label: 'CSS (.css)' },
  { ext: '.java', label: 'Java (.java)' },
  { ext: '.go', label: 'Go (.go)' },
  { ext: '.rs', label: 'Rust (.rs)' },
]

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
export default function FileTree({
  root,
  onOpenFile,
  refreshSeq = 0,
  activePath = null,
  isDirty,
  onPathRemoved,
  onPathRenamed,
}: Props) {
  const [state, setState] = useState<TreeState>(EMPTY_STATE)
  const [selected, setSelected] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(480)

  // 右键菜单：记录点击位置和落点（dir / file / blank 表示空白处 = 根目录）
  const [menu, setMenu] = useState<{
    x: number
    y: number
    path: string
    kind: 'dir' | 'file' | 'blank'
  } | null>(null)
  // 新建/重命名对话框
  const [dialog, setDialog] = useState<{
    mode: 'file' | 'dir' | 'rename'
    parent: string
    target?: string
    kind?: 'dir' | 'file'
  } | null>(null)
  const [dialogName, setDialogName] = useState('')
  const [dialogExt, setDialogExt] = useState('')
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)

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
    (rel: string, isDir: boolean, edit = false) => {
      if (!isDir) {
        setSelected(rel)
        onOpenFile(rel, undefined, edit)
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

  // ---------- 结构操作：新建 / 重命名 / 删除 ----------

  const joinRel = useCallback((parent: string, name: string) => {
    const base = parent.replace(/[\\/]+$/, '')
    return base ? `${base}\\${name}` : name
  }, [])

  const parentOf = useCallback((rel: string) => {
    const parts = rel.replace(/[\\/]+$/, '').split(/[\\/]/)
    parts.pop()
    return parts.join('\\')
  }, [])

  /** 目标路径（含目录本身）是否覆盖当前打开的文件。 */
  const affectsActive = useCallback(
    (rel: string) => {
      if (!activePath) return false
      const target = rel.replace(/[\\/]+$/, '')
      if (!target) return false
      return (
        activePath === target ||
        activePath.startsWith(`${target}\\`) ||
        activePath.startsWith(`${target}/`)
      )
    },
    [activePath],
  )

  /** 把某个路径及其子孙在缓存里的目录状态全部丢掉（删除/重命名后用）。 */
  const forgetSubtree = useCallback((rel: string) => {
    const target = rel.replace(/[\\/]+$/, '')
    if (!target) return
    const drop = <T,>(record: Record<string, T>): Record<string, T> => {
      const next: Record<string, T> = {}
      for (const [key, value] of Object.entries(record)) {
        if (key === target || key.startsWith(`${target}\\`) || key.startsWith(`${target}/`)) continue
        next[key] = value
      }
      return next
    }
    setState((prev) => ({
      children: drop(prev.children),
      expanded: drop(prev.expanded),
      loading: drop(prev.loading),
      loaded: drop(prev.loaded),
      errors: drop(prev.errors),
    }))
  }, [])

  const openDialog = useCallback(
    (
      mode: 'file' | 'dir' | 'rename',
      parent: string,
      initial: string,
      target?: string,
      kind?: 'dir' | 'file',
    ) => {
      setMenu(null)
      setDialog({ mode, parent, target, kind })
      setDialogName(initial)
      setDialogExt('')
      setDialogError(null)
      setDialogBusy(false)
    },
    [],
  )

  function applyKind(next: string) {
    setDialogExt(next)
    if (!next) return
    setDialogName((prev) => {
      const trimmed = prev.trim()
      if (!trimmed) return `untitled${next}`
      const stem = trimmed.replace(/\.[^./\\]*$/, '') || trimmed
      return `${stem}${next}`
    })
  }

  async function submitDialog() {
    if (!dialog || dialogBusy) return
    const name = dialogName.trim()
    if (!name) {
      setDialogError('名字不能为空')
      return
    }
    setDialogBusy(true)
    setDialogError(null)
    try {
      if (dialog.mode === 'rename') {
        const from = dialog.target ?? ''
        const to = joinRel(dialog.parent, name)
        if (from === to) {
          setDialog(null)
          return
        }
        await renameLocal(root, from, to)
        onPathRenamed?.(from, to)
        forgetSubtree(from)
        setSelected(dialog.kind === 'dir' ? `${to}\\` : to)
        const oldParent = parentOf(from)
        if (oldParent !== dialog.parent) void load(oldParent)
        void load(dialog.parent)
        setDialog(null)
        return
      }

      const rel = joinRel(dialog.parent, name)
      if (dialog.mode === 'dir') {
        await mkdirLocal(root, rel)
        setState((prev) => ({ ...prev, expanded: { ...prev.expanded, [dialog.parent]: true } }))
        setSelected(`${rel}\\`)
      } else {
        await createFileLocal(root, rel)
        setState((prev) => ({ ...prev, expanded: { ...prev.expanded, [dialog.parent]: true } }))
        setSelected(rel)
      }
      void load(dialog.parent)
      setDialog(null)
      if (dialog.mode === 'file') onOpenFile(rel)
    } catch (err) {
      setDialogError((err as Error).message)
    } finally {
      setDialogBusy(false)
    }
  }

  async function removeEntry(rel: string, kind: 'dir' | 'file') {
    setMenu(null)
    const name = baseName(rel)
    if (affectsActive(rel) && isDirty?.()) {
      if (!window.confirm(`当前打开的文件有未保存的修改，仍要删除「${name}」？`)) return
    }
    const message = kind === 'dir' ? `删除文件夹「${name}」及其中所有内容？` : `删除「${name}」？`
    if (!window.confirm(message)) return
    try {
      await deleteLocal(root, rel)
    } catch (err) {
      window.alert(`删除失败：${(err as Error).message}`)
      return
    }
    onPathRemoved?.(rel)
    forgetSubtree(rel)
    setSelected('')
    void load(parentOf(rel))
  }

  // Esc 关闭右键菜单 / 对话框
  useEffect(() => {
    if (!menu && !dialog) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (dialog && !dialogBusy) setDialog(null)
      setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu, dialog, dialogBusy])

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
      <div
        className="tree-scroll"
        ref={attachScroll}
        onScroll={onScroll}
        onContextMenu={(event) => {
          // 行上的右键会 stopPropagation，能冒到这里的只有空白区域
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY, path: '', kind: 'blank' })
        }}
      >
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
              onDoubleClick={() => {
                // 双击文件 = 打开并直接进编辑（双击目录不处理，避免把展开又折叠）
                if (row.kind === 'file') activate(row.path, false, true)
              }}
              onContextMenu={(event) => {
                if (row.kind === 'status') return
                event.preventDefault()
                event.stopPropagation()
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  path: row.path,
                  kind: row.kind === 'dir' ? 'dir' : 'file',
                })
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

      {menu ? (
        <div
          className="tree-menu-layer"
          onMouseDown={() => setMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenu(null)
          }}
        >
          <div
            className="tree-menu"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {menu.kind !== 'file' ? (
              <>
                <button
                  type="button"
                  onClick={() => openDialog('file', menu.kind === 'dir' ? menu.path : '', '')}
                >
                  新建文件
                </button>
                <button
                  type="button"
                  onClick={() => openDialog('dir', menu.kind === 'dir' ? menu.path : '', '')}
                >
                  新建文件夹
                </button>
                <div className="tree-menu-sep" />
              </>
            ) : null}
            {menu.kind !== 'blank' ? (
              <>
                <button
                  type="button"
                  onClick={() =>
                    openDialog(
                      'rename',
                      parentOf(menu.path),
                      baseName(menu.path),
                      menu.path,
                      menu.kind === 'dir' ? 'dir' : 'file',
                    )
                  }
                >
                  重命名
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => void removeEntry(menu.path, menu.kind === 'dir' ? 'dir' : 'file')}
                >
                  删除
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {dialog ? (
        <div
          className="tree-dialog-layer"
          onMouseDown={() => {
            if (!dialogBusy) setDialog(null)
          }}
        >
          <form
            className="tree-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault()
              void submitDialog()
            }}
          >
            <div className="tree-dialog-title">
              {dialog.mode === 'file' ? '新建文件' : dialog.mode === 'dir' ? '新建文件夹' : '重命名'}
            </div>
            <input
              className="tree-dialog-name"
              autoFocus
              value={dialogName}
              placeholder={dialog.mode === 'file' ? '例如 main.cpp' : '名称'}
              aria-label="名称"
              onChange={(event) => setDialogName(event.target.value)}
            />
            {dialog.mode === 'file' ? (
              <label className="tree-dialog-kind">
                <span>类型</span>
                <select
                  value={dialogExt}
                  aria-label="文件类型"
                  onChange={(event) => applyKind(event.target.value)}
                >
                  {CODE_KINDS.map((kind) => (
                    <option key={kind.label} value={kind.ext}>
                      {kind.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {dialogError ? <div className="tree-dialog-error">{dialogError}</div> : null}
            <div className="tree-dialog-actions">
              <button
                type="button"
                className="tree-dialog-btn"
                disabled={dialogBusy}
                onClick={() => setDialog(null)}
              >
                取消
              </button>
              <button type="submit" className="tree-dialog-btn primary" disabled={dialogBusy}>
                {dialogBusy ? '处理中…' : '确定'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  )
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}
