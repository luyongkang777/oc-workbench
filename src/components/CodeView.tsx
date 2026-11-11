import { useCallback, useEffect, useRef, useState } from 'react'
import {
  readLines,
  readText,
  searchFile,
  statFile,
  writeText,
  type FileStat,
  type SearchMatch,
} from '../api/localfs'
import CodeEditor from './CodeEditor'
import CodeSourceBody from './CodeSourceBody'
import CodeSearchBar from './CodeSearchBar'
import CodeToolbar from './CodeToolbar'
import { coveringEntry, isFailure, loadedEnd, type Entry } from './codeCache'
import {
  MAX_PAGES,
  WINDOW_LINES,
  cycleIndex,
  isImagePath,
  isMarkdownPath,
  lineAtScrollTop,
  scrollModel,
  scrollTopForLine,
  visibleRange,
} from './codeWindow'
import MarkdownText from './MarkdownText'
import { useFilePreview } from '../hooks/useFilePreview'

/** 超过这个大小不进入编辑：整份文本要一次性载入，太大打字会卡。 */
const EDIT_MAX_BYTES = 2 * 1024 * 1024
/** 后端支持的保存编码；stat.encoding 返回的也是这几个名字。 */
const SAVE_ENCODINGS = ['utf8', 'utf16le', 'utf16be', 'gbk']

type Props = {
  root: string
  path: string | null
  /** 每次点文件自增：点同一个文件也能强制重读。 */
  openSeq: number
  /** 打开后要跳到的行（1 基）；null 表示不跳。 */
  openLine?: number | null
  /** 预览里的 Markdown 若含文件路径，点开别的文件。 */
  onOpenFile?: (path: string, line?: number) => void
  /** 编辑中是否有未保存改动（外层切文件前用来拦一下）。 */
  onDirtyChange?: (dirty: boolean) => void
  /** 保存成功（外层可刷新文件树里的大小）。 */
  onSaved?: (path: string) => void
  /** 外层要求「打开后直接进编辑」（双击文件树时自增）。 */
  autoEditSeq?: number
  /** 当前文件在工作区外时，它自己的根目录；null/undefined 表示就在工作区里。 */
  externalRoot?: string | null
  /** 点「外部文件」标记：把工作区切到这个目录。 */
  onUseExternalRoot?: (root: string) => void
}

/**
 * 路径栏：工作区外的文件在路径右边挂一个可点的「外部文件」标记，
 * 免得文件树里没有高亮时让人以为文件没打开。
 */
function PathBar({
  path,
  externalRoot,
  onUseExternalRoot,
}: {
  path: string | null
  externalRoot?: string | null
  onUseExternalRoot?: (root: string) => void
}) {
  return (
    <div className="editor-path" title={path ?? ''}>
      <span className="editor-path-text">{path}</span>
      {externalRoot ? (
        <button
          type="button"
          className="editor-external"
          title={`这个文件不在当前工作区。点一下把工作区切到 ${externalRoot}`}
          onClick={() => onUseExternalRoot?.(externalRoot)}
        >
          外部文件 · {externalRoot}
        </button>
      ) : null}
    </div>
  )
}

/**
 * 代码/文档查看器：任意大小文件都只看「视口里的几十行」。
 *
 * 数据流：stat（行数 + 编码 + 是否二进制）→ 按行分页按需取。
 * 服务端可能因为 512KB 上限少给几行，所以每页记 `next`，缺口从 next 续拉，
 * 不能假设「一页就是 200 行」。快速连点文件时 abort 所有在途页请求，旧响应凭 gen 丢弃。
 *
 * 编辑（2MB 以内）：双击代码进入整份文本的 textarea，Ctrl+S 原子写回磁盘，
 * 带 mtime 冲突检测；编码支持 UTF-8 / UTF-16LE / UTF-16BE / GBK，保存时可换编码。
 */
export default function CodeView({
  root,
  path,
  openSeq,
  openLine,
  onOpenFile,
  onDirtyChange,
  onSaved,
  autoEditSeq = 0,
  externalRoot = null,
  onUseExternalRoot,
}: Props) {
  const [stat, setStat] = useState<FileStat | null>(null)
  const [statPath, setStatPath] = useState<string | null>(null)
  const [statError, setStatError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [reload, setReload] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  const [version, setVersion] = useState(0)
  const [flashLine, setFlashLine] = useState<number | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<SearchMatch[]>([])
  const [matchIndex, setMatchIndex] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  // 编辑态：draft 是 textarea 里的整份文本，baseline 是打开/上次保存时的原文。
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [baseline, setBaseline] = useState('')
  const [editLoading, setEditLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [saveNote, setSaveNote] = useState<string | null>(null)
  // 保存编码：默认沿用文件原编码，可在工具栏改成 UTF-8 / UTF-16 / GBK
  const [saveEncoding, setSaveEncoding] = useState('utf8')
  // 编码覆盖（null = 自动）：非编辑态选「以 X 编码重新打开」时置上，所有读取都按它解码
  const [encodingOverride, setEncodingOverride] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const cacheRef = useRef(new Map<number, Entry>())
  const inflightRef = useRef(new Map<number, AbortController>())
  const genRef = useRef(0)
  const rafRef = useRef(0)
  const scrollTopRef = useRef(0)
  const observerRef = useRef<ResizeObserver | null>(null)
  const flashTimer = useRef(0)
  const jumpRef = useRef<HTMLInputElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const lastSearchJump = useRef('')
  const searchOpenRef = useRef(false)
  const statRef = useRef<FileStat | null>(null)
  const pathRef = useRef<string | null>(path)
  pathRef.current = path

  const bump = useCallback(() => setVersion((value) => value + 1), [])
  searchOpenRef.current = searchOpen
  statRef.current = stat
  const previewState = useFilePreview(root, path, stat, encodingOverride)
  const { mode, setMode, preview, previewError, hex, hexError, imageUrl, imageError } = previewState

  // 换编码也算「要保存的改动」：允许不改文本、只把文件转成另一种编码
  const encodingChanged = editing && !!stat && stat.encoding !== saveEncoding
  const dirty = editing && (draft !== baseline || encodingChanged)

  // 外层用这个 ref 拦「切文件会丢掉未保存改动」；卸载时也要清掉。
  const dirtyNotifyRef = useRef(onDirtyChange)
  dirtyNotifyRef.current = onDirtyChange
  useEffect(() => {
    dirtyNotifyRef.current?.(dirty)
  }, [dirty])
  useEffect(() => () => dirtyNotifyRef.current?.(false), [])

  // 保存成功后的「已保存」提示两秒后自己消失。
  useEffect(() => {
    if (!saveNote) return
    const timer = window.setTimeout(() => setSaveNote(null), 2000)
    return () => window.clearTimeout(timer)
  }, [saveNote])

  const canEditHint = !stat
    ? null
    : stat.binary
      ? '二进制文件不支持编辑'
      : stat.size > EDIT_MAX_BYTES
        ? `文件超过 ${Math.round(EDIT_MAX_BYTES / 1024 / 1024)}MB，暂不支持编辑`
        : null

  /** 进入编辑：整份文本一次载入（≤2MB），Markdown 自动切回源码。 */
  const startEdit = useCallback(() => {
    if (!path || saving || canEditHint) return
    const target = path
    const detected = statRef.current?.encoding ?? ''
    setSaveEncoding(SAVE_ENCODINGS.includes(detected) ? detected : 'utf8')
    setEditError(null)
    setSaveNote(null)
    setEditLoading(true)
    setSearchOpen(false)
    setMode('source')
    readText(root, target, EDIT_MAX_BYTES, encodingOverride)
      .then((text) => {
        // 读取期间已经切走文件：这份内容不能再塞给新文件。
        if (pathRef.current !== target) return
        setDraft(text)
        setBaseline(text)
        setEditing(true)
      })
      .catch((err) => setEditError(`无法编辑：${(err as Error).message}`))
      .finally(() => setEditLoading(false))
  }, [path, root, saving, canEditHint, setMode, encodingOverride])

  const cancelEdit = useCallback(() => {
    if (saving) return
    if (draft !== baseline && !window.confirm('放弃未保存的修改？')) return
    setEditing(false)
    setDraft('')
    setBaseline('')
    setEditError(null)
  }, [saving, draft, baseline])

  /**
   * 工具栏编码下拉：
   *   * 编辑态 = 保存编码（只影响写回）；
   *   * 非编辑态 = 以该编码重新读取（auto 回到自动探测）。
   */
  const handleEncodingChange = useCallback(
    (value: string) => {
      if (editing) {
        setSaveEncoding(value)
        return
      }
      setEncodingOverride(value === 'auto' ? null : value)
    },
    [editing],
  )

  const save = useCallback(() => {
    if (!path || !stat || saving || !editing) return
    if (draft === baseline && stat.encoding === saveEncoding) return
    setSaving(true)
    setEditError(null)
    writeText(root, path, draft, stat.mtimeMs, saveEncoding)
      .then((result) => {
        setBaseline(draft)
        setEditing(false)
        setSaveNote(
          `已保存 · ${result.lineCount.toLocaleString('en-US')} 行 · ${result.encoding.toUpperCase()}`,
        )
        // 只更新 stat（不触发整份重读），滚动位置和阅读上下文都保留
        cacheRef.current.clear()
        setStat((prev) =>
          prev
            ? {
                ...prev,
                size: result.size,
                mtimeMs: result.mtimeMs,
                lineCount: result.lineCount,
                encoding: result.encoding,
              }
            : prev,
        )
        onSaved?.(path)
      })
      .catch((err) => {
        const message = (err as Error).message
        setEditError(
          message.includes('409')
            ? '保存失败：文件已在磁盘上被修改，取消后重新打开再改'
            : `保存失败：${message}`,
        )
      })
      .finally(() => setSaving(false))
  }, [path, stat, saving, editing, draft, baseline, root, saveEncoding, onSaved])

  // 切文件/切根目录：结束编辑、回到自动编码（外层已经拦过未保存的情况）。
  useEffect(() => {
    setEditing(false)
    setDraft('')
    setBaseline('')
    setEditError(null)
    setSaving(false)
    setEncodingOverride(null)
  }, [path, root])

  // 双击文件树「打开即编辑」：stat 到位后进一次编辑，同一个信号只消费一次。
  const autoEditRef = useRef(0)
  useEffect(() => {
    if (!autoEditSeq || !path || !stat || statPath !== path) return
    if (autoEditRef.current === autoEditSeq) return
    autoEditRef.current = autoEditSeq
    if (canEditHint) return
    startEdit()
  }, [autoEditSeq, path, stat, statPath, canEditHint, startEdit])


  // 切文件/重试：清空缓存与在途请求。gen 自增让所有旧响应失效。
  useEffect(() => {
    const gen = ++genRef.current
    for (const controller of inflightRef.current.values()) controller.abort()
    inflightRef.current.clear()
    cacheRef.current.clear()
    setStat(null)
    setStatPath(null)
    setStatError(null)
    setScrollTop(0)
    scrollTopRef.current = 0
    if (!path) {
      setLoading(false)
      return
    }

    setLoading(true)
    const controller = new AbortController()
    statFile(root, path, encodingOverride, controller.signal)
      .then((value) => {
        if (gen !== genRef.current) return
        setStat(value)
        setStatPath(path)
      })
      .catch((err) => {
        if (gen !== genRef.current) return
        setStatError((err as Error).message)
      })
      .finally(() => {
        if (gen === genRef.current) setLoading(false)
      })

    if (scrollRef.current) scrollRef.current.scrollTop = 0
    return () => controller.abort()
  }, [root, path, openSeq, reload, encodingOverride])

  // 卸载：让所有回调失效，并中止在途请求。
  useEffect(
    () => () => {
      genRef.current += 1
      for (const controller of inflightRef.current.values()) controller.abort()
      inflightRef.current.clear()
      if (flashTimer.current) window.clearTimeout(flashTimer.current)
    },
    [],
  )

  // 回调 ref：切到预览/图片时滚动容器会卸载，回来时要把滚动位置写回去。
  const attachScroll = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    scrollRef.current = node
    if (!node) return
    node.scrollTop = scrollTopRef.current
    const update = () => setViewportHeight(node.clientHeight || 600)
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

  // 滚动用 rAF 合并：一次滚动只 setState 一次。
  const onScroll = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      if (!scrollRef.current) return
      scrollTopRef.current = scrollRef.current.scrollTop
      setScrollTop(scrollTopRef.current)
    })
  }, [])

  const requestPage = useCallback(
    (start: number, gen: number) => {
      if (inflightRef.current.has(start)) return
      const controller = new AbortController()
      inflightRef.current.set(start, controller)
      readLines(root, path ?? '', start, WINDOW_LINES, encodingOverride, controller.signal)
        .then((res) => {
          if (gen !== genRef.current) return
          const count = Math.max(0, res.next - res.start)
          let lines: string[]
          if (count === 0) lines = []
          else if (res.text === '') lines = new Array<string>(count).fill('')
          else {
            lines = res.text.split('\n')
            while (lines.length < count) lines.push('')
          }
          cacheRef.current.set(res.start, {
            start: res.start,
            lines,
            next: res.next,
            eof: res.eof,
          })
          // 只保留视口附近的页（±12 页），避免来回滚时内存无限涨。
          for (const entry of cacheRef.current.values()) {
            if (Math.abs(entry.start - start) > WINDOW_LINES * Math.floor(MAX_PAGES / 2)) {
              cacheRef.current.delete(entry.start)
            }
          }
          bump()
        })
        .catch((err) => {
          if (gen !== genRef.current) return
          if ((err as Error).name === 'AbortError') return
          cacheRef.current.set(start, { start, error: (err as Error).message })
          bump()
        })
        .finally(() => {
          if (inflightRef.current.get(start) === controller) {
            inflightRef.current.delete(start)
          }
        })
    },
    [root, path, encodingOverride, bump],
  )

  useEffect(() => {
    if (!searchOpen) return
    const input = searchRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [searchOpen])

  const model = scrollModel(stat?.lineCount ?? 0)
  const currentLine =
    stat && !stat.binary && previewState.mode === 'source' && stat.lineCount > 0
      ? lineAtScrollTop(scrollTop, stat.lineCount, model.scale)
      : null

  // Ctrl+S 保存 / Ctrl+G 跳转聚焦 / Ctrl+F 打开搜索 / Esc 关闭搜索或退出编辑。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && key === 's') {
        if (!editing) return
        event.preventDefault()
        save()
        return
      }
      if (event.key === 'Escape') {
        if (editing) {
          event.preventDefault()
          cancelEdit()
          return
        }
        if (searchOpenRef.current) setSearchOpen(false)
        return
      }
      if (!(event.ctrlKey || event.metaKey)) return
      // 编辑态交给 textarea 自己处理，别抢 Ctrl+G / Ctrl+F
      if (editing) return
      if (key === 'g') {
        const input = jumpRef.current
        if (!input) return
        event.preventDefault()
        input.focus()
        input.select()
        return
      }
      if (key === 'f') {
        // 二进制/图片没有文本可搜；Markdown 预览态自动切回源码。
        if (!statRef.current || statRef.current.binary) return
        event.preventDefault()
        setSearchOpen(true)
        setMode('source')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setMode, editing, save, cancelEdit])

  /** 跳转到 1 基行号：把该行放到视口顶部并闪一下。 */
  const jumpToLine = useCallback(
    (target: number) => {
      if (!stat || stat.lineCount === 0) return
      const viewport = scrollRef.current?.clientHeight ?? viewportHeight
      const line = Math.min(Math.max(1, Math.trunc(target)), stat.lineCount)
      const top = scrollTopForLine(line, stat.lineCount, viewport, model.scale)
      scrollTopRef.current = top
      setScrollTop(top)
      if (scrollRef.current) scrollRef.current.scrollTop = top
      setFlashLine(line - 1)
      if (flashTimer.current) window.clearTimeout(flashTimer.current)
      flashTimer.current = window.setTimeout(() => setFlashLine(null), 1200)
    },
    [stat, model.scale, viewportHeight],
  )

  // 聊天里点「a.ts:42」这类带行号的路径：文件读出来后跳一次。
  // 用 key 去重，避免重渲染（流式刷新、窗口 resize）反复抢滚动位置。
  const jumpedOpen = useRef('')
  useEffect(() => {
    if (typeof openLine !== 'number' || openLine <= 0) return
    if (!stat || statPath !== path || stat.binary || stat.lineCount === 0) return
    const key = `${path ?? ''}#${openSeq}#${openLine}`
    if (jumpedOpen.current === key) return
    jumpedOpen.current = key
    // Markdown 默认是预览态，要跳行必须切回源码
    if (previewState.mode !== 'source') setMode('source')
    jumpToLine(openLine)
  }, [openLine, openSeq, path, stat, statPath, previewState.mode, setMode, jumpToLine])

  // 搜索：250ms 防抖 + abort；文件/内容变化自动重跑。
  useEffect(() => {
    if (!searchOpen) return
    if (!path || !stat || stat.binary) {
      setMatches([])
      setTruncated(false)
      setSearching(false)
      setSearchError(null)
      setMatchIndex(0)
      return
    }
    const keyword = query.trim()
    if (!keyword) {
      setMatches([])
      setTruncated(false)
      setSearching(false)
      setSearchError(null)
      setMatchIndex(0)
      return
    }

    setSearching(true)
    setSearchError(null)
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      searchFile(root, path, keyword, 500, encodingOverride, controller.signal)
        .then((res) => {
          if (controller.signal.aborted) return
          setMatches(res.matches)
          setTruncated(res.truncated)
          setMatchIndex(0)
          setSearching(false)
        })
        .catch((err) => {
          if (controller.signal.aborted) return
          setMatches([])
          setSearchError((err as Error).message)
          setSearching(false)
        })
    }, 250)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [searchOpen, query, path, root, stat, encodingOverride])

  // 命中切换时跳到对应行；用 key 去重，避免窗口 resize 反复抢滚动位置。
  useEffect(() => {
    if (!searchOpen) {
      lastSearchJump.current = ''
      return
    }
    const match = matches[matchIndex]
    if (!match) return
    const key = `${match.line}:${matchIndex}:${matches.length}`
    if (lastSearchJump.current === key) return
    lastSearchJump.current = key
    jumpToLine(match.line + 1)
  }, [searchOpen, matches, matchIndex, jumpToLine])

  const stepMatch = useCallback(
    (delta: number) => {
      setMatchIndex((index) => (matches.length ? cycleIndex(index, matches.length, delta) : index))
    },
    [matches.length],
  )

  // 按视口补页：从 first 开始找第一个没有覆盖的行，拉一页就停；version 变化会再跑一轮。
  useEffect(() => {
    if (!path || !stat || stat.binary || previewState.mode !== 'source' || statPath !== path) {
      return
    }
    const { first, last } = visibleRange(scrollTop, viewportHeight, stat.lineCount, model.scale)
    const gen = genRef.current
    const end = loadedEnd(cacheRef.current)
    let cursor = first
    while (cursor <= last) {
      const entry = coveringEntry(cacheRef.current, cursor)
      if (entry) {
        if (isFailure(entry)) {
          cursor = entry.start + 1
        } else {
          cursor = entry.start + entry.lines.length
        }
        continue
      }
      // 已经读到文件尾（索引可能比文件长），不再对空白区发请求。
      if (end !== null && cursor >= end) break
      requestPage(cursor, gen)
      break
    }
  }, [
    root,
    path,
    stat,
    statPath,
    previewState.mode,
    scrollTop,
    viewportHeight,
    version,
    model.scale,
    requestPage,
  ])

  if (!path) {
    return (
      <div className="editor-empty">
        <div className="editor-empty-icon">⌘</div>
        <div>选择左侧文件查看</div>
      </div>
    )
  }

  if (statError) {
    return (
      <div className="editor">
        <PathBar path={path} externalRoot={externalRoot} onUseExternalRoot={onUseExternalRoot} />
        <div className="editor-error">
          <div>{statError}</div>
          <button type="button" className="editor-retry" onClick={() => setReload((v) => v + 1)}>
            重试
          </button>
        </div>
      </div>
    )
  }

  if (loading || !stat || statPath !== path) {
    return (
      <div className="editor">
        <PathBar path={path} externalRoot={externalRoot} onUseExternalRoot={onUseExternalRoot} />
        <div className="editor-empty">读取中…</div>
      </div>
    )
  }

  const image = isImagePath(path)
  const markdown = isMarkdownPath(path) && !stat.binary

  return (
    <div className="editor">
      <PathBar path={path} externalRoot={externalRoot} onUseExternalRoot={onUseExternalRoot} />
      <CodeToolbar
        stat={stat}
        markdown={markdown}
        mode={mode}
        onMode={setMode}
        onJump={jumpToLine}
        currentLine={editing ? null : currentLine}
        jumpRef={jumpRef}
        canEdit={canEditHint === null}
        editHint={canEditHint}
        editing={editing}
        dirty={dirty}
        saving={saving}
        encoding={editing ? saveEncoding : (encodingOverride ?? 'auto')}
        allowAuto={!editing}
        onEncoding={handleEncodingChange}
        onSave={save}
        onCancel={cancelEdit}
      />
      {saveNote ? <div className="editor-save-note">{saveNote}</div> : null}
      {editError ? (
        <div className="editor-error editor-error-bar">
          <span>{editError}</span>
          <button type="button" className="editor-retry" onClick={() => setEditError(null)}>
            知道了
          </button>
        </div>
      ) : null}
      {searchOpen && !editing ? (
        <CodeSearchBar
          query={query}
          onQuery={setQuery}
          count={matches.length}
          active={matchIndex}
          truncated={truncated}
          searching={searching}
          error={searchError}
          onPrev={() => stepMatch(-1)}
          onNext={() => stepMatch(1)}
          onClose={() => setSearchOpen(false)}
          inputRef={searchRef}
        />
      ) : null}

      {editing ? (
        editLoading ? (
          <div className="editor-empty">读取全文…</div>
        ) : (
          <CodeEditor
            text={draft}
            onChange={setDraft}
            onSave={save}
            onCancel={cancelEdit}
            saving={saving}
            root={root}
            path={path}
          />
        )
      ) : image ? (
        <div className="editor-image">
          {imageError ? (
            <div className="editor-error">{imageError}</div>
          ) : imageUrl ? (
            <img src={imageUrl} alt={path} />
          ) : (
            <div className="editor-empty">加载图片…</div>
          )}
        </div>
      ) : stat.binary ? (
        <div className="editor-hex">
          <div className="editor-note">二进制文件，显示前 4 KB 的十六进制内容。</div>
          <pre className="hex-dump">{hexError ?? hex ?? '读取中…'}</pre>
        </div>
      ) : markdown && mode === 'preview' ? (
        <div className="editor-preview" onDoubleClick={startEdit} title="双击编辑">
          {previewError ? (
            <div className="editor-note">{previewError}</div>
          ) : preview === null ? (
            <div className="editor-empty">渲染中…</div>
          ) : (
            <MarkdownText text={preview} onOpenFile={onOpenFile} />
          )}
        </div>
      ) : stat.lineCount === 0 ? (
        <div className="editor-empty">空文件</div>
      ) : (
        <CodeSourceBody
          stat={stat}
          cache={cacheRef.current}
          scrollTop={scrollTop}
          viewportHeight={viewportHeight}
          scale={model.scale}
          onScroll={onScroll}
          attachScroll={attachScroll}
          flashLine={flashLine}
          query={searchOpen ? query.trim() : ''}
          matchLine={searchOpen ? matches[matchIndex]?.line ?? null : null}
          onRetryPage={(start) => {
            const controller = inflightRef.current.get(start)
            controller?.abort()
            inflightRef.current.delete(start)
            cacheRef.current.delete(start)
            bump()
          }}
          onDoubleClick={startEdit}
        />
      )}
    </div>
  )
}
