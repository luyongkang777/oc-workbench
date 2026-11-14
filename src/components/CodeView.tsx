import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { coveringEntry, isFailure, loadedEnd, type Entry, type Page } from './codeCache'
import {
  LINE_HEIGHT,
  MAX_PAGES,
  WINDOW_LINES,
  cycleIndex,
  isHtmlPath,
  isImagePath,
  isMarkdownPath,
  lineAtScrollTop,
  scrollModel,
  scrollTopForLine,
  visibleRange,
} from './codeWindow'
import {
  buildWrapLayout,
  lineAtRow,
  lineAtScrollTop as lineAtScrollTopWrapped,
  rowOffsetOf,
  scrollTopForLineIn,
  visibleRangeIn,
  wrapRows,
  type WrapLayout,
} from './wrapLayout'
import { measureCodeMetrics, type CodeMetrics } from './textMetrics'
import { readWrapPref, writeWrapPref } from './wrapPrefs'
import MarkdownText from './MarkdownText'
import { useFilePreview } from '../hooks/useFilePreview'
import EditorImage from './EditorImage'
import { useViewZoom, useZoomKeys, useZoomWheel } from '../hooks/useViewZoom'
import { zoomFromWheel } from './viewZoom'
/** 超过这个大小不进入编辑：整份文本要一次性载入，太大打字会卡。 */
const EDIT_MAX_BYTES = 2 * 1024 * 1024
/** 后端支持的保存编码；stat.encoding 返回的也是这几个名字。 */
const SAVE_ENCODINGS = ['utf8', 'utf16le', 'utf16be', 'gbk']
/** 自动换行的偏好（与审查面板共用，按项目根记忆）。 */
/** 行号栏宽度，与 `.line-no { flex: 0 0 56px }` 一致（含右侧内边距）。 */
const GUTTER_PX = 56
/**
 * 文本区右边留多少像素余量。实测（240~1100px 共 1.2 万个样本）：
 * 0~3px 都不会低估，1px 的「估多一行」最少。真低估了也不会压字——
 * 行用 min-height，内容多一点盒子自己长高，再被实测回填。
 */
const WRAP_SLACK_PX = 1

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
  /** 打开失败（常见于文件树里的旧条目已被删/改名）：外层可据此提示并刷新文件树。 */
  onOpenFailed?: (path: string, message: string) => void
  /** 点路径栏的 × 关掉当前文件（外层把 file 置空，回到「选择左侧文件查看」）。 */
  onClose?: () => void
}

/**
 * 路径栏：工作区外的文件在路径右边挂一个可点的「外部文件」标记，
 * 免得文件树里没有高亮时让人以为文件没打开。
 */
function PathBar({
  path,
  externalRoot,
  onUseExternalRoot,
  onClose,
}: {
  path: string | null
  externalRoot?: string | null
  onUseExternalRoot?: (root: string) => void
  onClose?: () => void
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
      {onClose ? (
        <button
          type="button"
          className="editor-close"
          title="关闭当前文件"
          aria-label="关闭当前文件"
          onClick={onClose}
        />
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
  onOpenFailed,
  onClose,
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

  // 自动换行：默认开，按项目（root）各记各的。容器宽度 + 字体度量一起决定
  // 每行占几个视觉行（换行后行高不再是常量）。
  const [wrap, setWrap] = useState(() => readWrapPref(root))
  const [viewportWidth, setViewportWidth] = useState(0)
  const [metrics, setMetrics] = useState<CodeMetrics>({ charWidth: 7.5, wideWidth: 15 })
  // 换项目：读回这个项目自己的换行偏好
  useEffect(() => {
    setWrap(readWrapPref(root))
  }, [root])

  // 查看区缩放：与全局界面缩放（useUiLayout）互不影响，鼠标在查看区内时 Ctrl+滚轮只缩放这里。
  // 图片和文本各记一套比例：把代码放大到 150% 不该影响看图片时的默认「适应窗口」。
  const isImage = Boolean(path && isImagePath(path))
  const viewZoom = useViewZoom(root, isImage ? 'image' : 'text')
  const zoomHostRef = useRef<HTMLDivElement | null>(null)
  useZoomWheel(zoomHostRef, true, (deltaY) => {
    viewZoom.setZoom(zoomFromWheel(viewZoom.zoom, deltaY))
  })
  useZoomKeys(zoomHostRef, true, viewZoom.zoomIn, viewZoom.zoomOut, viewZoom.resetZoom)

  // 渲染后实测到的每行视觉行数：估算对不齐时以它为准（见 handleMeasured）
  const measuredRef = useRef(new Map<number, number>())
  // 量过但和模型一致的行：不必再量（否则滚动时每帧都在重复读 offsetHeight）
  const verifiedRef = useRef(new Set<number>())
  const [measuredSeq, setMeasuredSeq] = useState(0)
  // 每页的视觉行数缓存：一页 200 行算一次，别在每次重建时把所有缓存页重算一遍
  const pageRowsRef = useRef(new Map<number, Uint16Array>())
  const pageRowsKeyRef = useRef('')

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
  // 换行布局的当前值：给 rAF 里的滚动回调读，避免它依赖 layout 而反复重建
  const layoutRef = useRef<WrapLayout | null>(null)
  // 滚动锚点：换行布局变高时用来把画面补偿回原位
  const anchorRef = useRef<{ line: number; offset: number; total: number } | null>(null)
  // 视口首行（0 基）：切换换行模式后按它重新定位
  const topLineRef = useRef(0)

  const bump = useCallback(() => setVersion((value) => value + 1), [])
  /** 布局缓存全部作废（换了宽度、字体或文件内容）：行数重算、实测重做。 */
  const resetLayoutCaches = useCallback(() => {
    const hadMeasured = measuredRef.current.size > 0
    measuredRef.current.clear()
    verifiedRef.current.clear()
    pageRowsRef.current.clear()
    if (hadMeasured) setMeasuredSeq((value) => value + 1)
  }, [])
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

  // 打开失败的回调同理走 ref：effect 的依赖里不放回调，避免每次渲染重跑 stat。
  const openFailedRef = useRef(onOpenFailed)
  openFailedRef.current = onOpenFailed

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
        resetLayoutCaches()
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
    anchorRef.current = null
    topLineRef.current = 0
    resetLayoutCaches()
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
        const message = (err as Error).message
        setStatError(message)
        // 文件不存在/权限不足都走这里：告诉外层，好在提示之后刷新文件树
        openFailedRef.current?.(path, message)
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
    const update = () => {
      setViewportHeight(node.clientHeight || 600)
      setViewportWidth(node.clientWidth || 0)
      // 换行算的是「一行能放几个字符位」，必须用真实字体量出来的宽度
      const block = node.querySelector('.code-block')
      const next = measureCodeMetrics(block instanceof HTMLElement ? block : node)
      setMetrics((prev) =>
        prev.charWidth === next.charWidth && prev.wideWidth === next.wideWidth ? prev : next,
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    observerRef.current = observer
  }, [])

  // 中文/等宽字体加载完成后字宽会变（回退字体先顶上），重新量一次，免得第一屏行数算错
  useEffect(() => {
    let alive = true
    const fonts = document.fonts
    if (!fonts?.ready) return
    void fonts.ready.then(() => {
      const node = scrollRef.current
      if (!alive || !node) return
      const block = node.querySelector('.code-block')
      const next = measureCodeMetrics(block instanceof HTMLElement ? block : node)
      setMetrics((prev) =>
        prev.charWidth === next.charWidth && prev.wideWidth === next.wideWidth ? prev : next,
      )
    })
    return () => {
      alive = false
    }
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
      const top = scrollRef.current.scrollTop
      scrollTopRef.current = top
      setScrollTop(top)
      // 顺手记下「视口首行」和它的偏移，布局重建后靠这两个值把画面钉在原处
      const current = layoutRef.current
      if (current) {
        const per = Math.max(LINE_HEIGHT * current.scale, 0.001)
        const line = lineAtRow(current, top / per)
        topLineRef.current = line
        anchorRef.current = { line, offset: rowOffsetOf(current, line), total: current.totalRows }
        return
      }
      const lines = statRef.current?.lineCount ?? 0
      const model = scrollModel(lines)
      const per = Math.max(LINE_HEIGHT * model.scale, 0.001)
      topLineRef.current = Math.min(
        Math.max(0, Math.floor(top / per)),
        Math.max(lines - 1, 0),
      )
      anchorRef.current = null
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

  // 文本区可用宽度（px）：容器宽度减去行号栏，再留 1px 吸收亚像素取整。
  // 必须用像素而不是「几个字符位」：实测中文只有半角的 1.775 倍，按整数格折算
  // 会让中文行的行数算多，多出一行空白。
  const lineCount = stat?.lineCount ?? 0
  const availPx = viewportWidth > 0 ? viewportWidth - GUTTER_PX - WRAP_SLACK_PX : 0
  const wrapActive = wrap && availPx >= 40

  // 可用宽度或字宽变了，之前的实测行数全部失效（重排后重新量）。
  // 用 layout effect：在绘制前清掉，避免拿旧宽度量出来的行数闪一帧。
  useLayoutEffect(() => {
    resetLayoutCaches()
  }, [availPx, metrics.charWidth, resetLayoutCaches])

  /**
   * 换行布局表。只把「比 1 行多出来的视觉行」记进前缀和，未加载的行按 1 行计，
   * 等页面读回来（version 自增）再重建。几千条已知行重建一次可以忽略不计。
   *
   * 行数优先用渲染后的实测值：估算是逐字模拟折行，遇到 Chromium 的避头尾规则
   * （`>`、`,`、`.` 前不折）会差一行。实测值一旦回填，滚动位置就是精确的。
   */
  const pageRowsFor = useCallback(
    (entry: Page): Uint16Array => {
      const key = `${availPx}|${metrics.charWidth}|${metrics.wideWidth}`
      if (pageRowsKeyRef.current !== key) {
        pageRowsKeyRef.current = key
        pageRowsRef.current.clear()
      }
      const cached = pageRowsRef.current.get(entry.start)
      if (cached && cached.length === entry.lines.length) return cached
      const rows = new Uint16Array(entry.lines.length)
      for (let i = 0; i < entry.lines.length; i += 1) {
        rows[i] = wrapRows(entry.lines[i], availPx, metrics)
      }
      if (pageRowsRef.current.size > 40) pageRowsRef.current.clear()
      pageRowsRef.current.set(entry.start, rows)
      return rows
    },
    [availPx, metrics],
  )

  /**
   * 换行布局表。每页的行数走 pageRowsFor 的缓存，这里只做累加。
   * 没有页级缓存时，每回填一次实测 / 每加载一页都要重算全部缓存行（实测 4800 行 ≈ 2.5ms），
   * 滚动时每帧一次就是肉眼可见的卡。
   */
  const layout = useMemo<WrapLayout | null>(() => {
    if (!wrapActive || lineCount <= 0) return null
    const measured = measuredRef.current
    const known: [number, number][] = []
    for (const entry of cacheRef.current.values()) {
      if (isFailure(entry)) continue
      // 每页的行数只算一次（换宽度才失效）：一页 200 行，别每次重建都把 24 页重算
      const rowsOfPage = pageRowsFor(entry)
      for (let i = 0; i < entry.lines.length; i += 1) {
        const line = entry.start + i
        const rows = measured.get(line) ?? rowsOfPage[i]
        if (rows > 1) known.push([line, rows])
      }
    }
    return buildWrapLayout(lineCount, known)
    // version 每加载一页自增；measuredSeq 每次实测回填自增：两者都会改变行数分布
    // path 也进依赖：换文件时缓存被清空，即使行数相同也要按空缓存重算一次
  }, [path, wrapActive, lineCount, pageRowsFor, version, measuredSeq])

  /** 某行占几个视觉行（实测优先）。未加载 / 加载失败的行按 1 行算。 */
  const rowsOf = useCallback(
    (line: number): number => {
      const known = measuredRef.current.get(line)
      if (known !== undefined) return known
      const entry = coveringEntry(cacheRef.current, line)
      if (!entry || isFailure(entry)) return 1
      const text = entry.lines[line - entry.start]
      return text === undefined ? 1 : wrapRows(text, availPx, metrics)
    },
    [availPx, metrics, measuredSeq],
  )

  /**
   * 渲染后的实测结果。不一致的行回填进布局表；一致的行只记「已量过」，
   * 下次滚动路过不再重复读 offsetHeight（读它要强制浏览器重排，是滚动卡顿的大头）。
   */
  const handleMeasured = useCallback((entries: [number, number, boolean][]) => {
    let changed = false
    for (const [line, rows, differs] of entries) {
      if (differs) {
        if (measuredRef.current.get(line) !== rows) {
          measuredRef.current.set(line, rows)
          changed = true
        }
        verifiedRef.current.delete(line)
        continue
      }
      verifiedRef.current.add(line)
      if (verifiedRef.current.size > 50_000) verifiedRef.current.clear()
    }
    if (changed) setMeasuredSeq((value) => value + 1)
  }, [])

  const isMeasured = useCallback(
    (line: number) => verifiedRef.current.has(line) || measuredRef.current.has(line),
    [],
  )

  // 当前视口的渲染区间与上下占位（px）。换行 / 不换行两套数学，其余代码只看这个结果。
  const view = useMemo(() => {
    if (!stat || stat.binary) return { first: 0, last: 0, topPad: 0, bottomPad: 0, scale: 1 }
    if (layout) {
      const range = visibleRangeIn(layout, scrollTop, viewportHeight)
      const per = LINE_HEIGHT * layout.scale
      return {
        first: range.first,
        last: range.last,
        topPad: rowOffsetOf(layout, range.first) * per,
        bottomPad: Math.max(0, (layout.totalRows - rowOffsetOf(layout, range.last + 1)) * per),
        scale: layout.scale,
      }
    }
    const model = scrollModel(stat.lineCount)
    const range = visibleRange(scrollTop, viewportHeight, stat.lineCount, model.scale)
    return {
      first: range.first,
      last: range.last,
      topPad: range.first * LINE_HEIGHT * model.scale,
      bottomPad: Math.max(0, (stat.lineCount - range.last - 1) * LINE_HEIGHT * model.scale),
      scale: model.scale,
    }
  }, [stat, layout, scrollTop, viewportHeight])

  const currentLine =
    stat && !stat.binary && previewState.mode === 'source' && stat.lineCount > 0
      ? layout
        ? lineAtScrollTopWrapped(layout, scrollTop)
        : lineAtScrollTop(scrollTop, stat.lineCount, view.scale)
      : null

  layoutRef.current = layout

  // 切换换行：内容总高度整体重排，按「当前首行」重新定位，别让用户丢坐标。
  const wrapApplied = useRef(wrap)
  useEffect(() => {
    if (wrapApplied.current === wrap) return
    wrapApplied.current = wrap
    const node = scrollRef.current
    if (!node) return
    const per = Math.max(LINE_HEIGHT * (layout ? layout.scale : scrollModel(lineCount).scale), 0.001)
    const top = layout
      ? rowOffsetOf(layout, topLineRef.current) * per
      : topLineRef.current * per
    node.scrollTop = top
    scrollTopRef.current = node.scrollTop
    setScrollTop(node.scrollTop)
  }, [wrap, layout, lineCount])

  // 缩放会改变「一行能放几个字符」→ 换行模式下每行折成几个视觉行整体重排，
  // 内容总高度跟着变；如果什么都不做，视口会顺着新布局滑走几十行。
  // 做法：记住缩放瞬间的视口首行，再用若干帧 rAF 反复把它顶回视口顶部
  // （布局重排要等 ResizeObserver 回报新宽度，单次 set 会落空）。
  const zoomApplied = useRef(viewZoom.zoom)
  const zoomFixRef = useRef<{ line: number; frames: number } | null>(null)
  useEffect(() => {
    if (zoomApplied.current === viewZoom.zoom) return
    zoomApplied.current = viewZoom.zoom
    zoomFixRef.current = { line: topLineRef.current, frames: 10 }
    let raf = 0
    const step = () => {
      const fix = zoomFixRef.current
      if (!fix) return
      const node = scrollRef.current
      // 图片 / Markdown 预览等视图没有代码滚动容器：这一轮不用修正，标记也要清掉，
      // 否则回到文本视图时锚点补偿会被它永久挡住。
      if (!node) {
        zoomFixRef.current = null
        return
      }
      const current = layoutRef.current
      if (current) {
        const per = Math.max(LINE_HEIGHT * current.scale, 0.001)
        node.scrollTop = rowOffsetOf(current, fix.line) * per
        scrollTopRef.current = node.scrollTop
        setScrollTop(node.scrollTop)
      }
      fix.frames -= 1
      if (fix.frames <= 0) {
        zoomFixRef.current = null
        return
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      zoomFixRef.current = null
    }
  }, [viewZoom.zoom])

  // 换行布局会随页面加载变高（长行从 1 行变成 N 行）。视口上方长高会把画面顶走，
  // 所以用滚动锚点把位置补偿回去，视觉上停在原处。
  // 缩放正在收敛时（zoomFixRef 非空）跳过，免得两套补偿互相打架。
  useEffect(() => {
    const node = scrollRef.current
    const anchor = anchorRef.current
    if (!node || !anchor || !layout || zoomFixRef.current) return
    if (anchor.total === layout.totalRows) return
    const per = Math.max(LINE_HEIGHT * layout.scale, 0.001)
    const offset = rowOffsetOf(layout, anchor.line)
    const delta = (offset - anchor.offset) * per
    anchorRef.current = { line: anchor.line, offset, total: layout.totalRows }
    if (!delta) return
    node.scrollTop += delta
    scrollTopRef.current = node.scrollTop
    setScrollTop(node.scrollTop)
  }, [layout])

  /** 工具栏的「换行」开关：偏好存起来，下次打开同一个文件还按上次的来。 */
  const toggleWrap = useCallback(() => {
    setWrap((cur) => {
      const next = !cur
      writeWrapPref(root, next)
      return next
    })
  }, [root])

  /** 某一页读取失败后重试：只丢这一页的行数缓存，其它页不动。 */
  const retryPage = useCallback(
    (start: number) => {
      inflightRef.current.get(start)?.abort()
      inflightRef.current.delete(start)
      cacheRef.current.delete(start)
      pageRowsRef.current.delete(start)
      bump()
    },
    [bump],
  )

  // Ctrl+S 保存 / Ctrl+G 跳转聚焦 / Ctrl+F 打开搜索 / Esc 关闭搜索或退出编辑。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      // Alt+Z：切换自动换行（和 VS Code 的习惯一致）
      if (event.altKey && !event.ctrlKey && !event.metaKey && key === 'z') {
        event.preventDefault()
        toggleWrap()
        return
      }
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
  }, [setMode, editing, save, cancelEdit, toggleWrap])

  /** 跳转到 1 基行号：把该行放到视口顶部并闪一下。 */
  const jumpToLine = useCallback(
    (target: number) => {
      if (!stat || stat.lineCount === 0) return
      const viewport = scrollRef.current?.clientHeight ?? viewportHeight
      const line = Math.min(Math.max(1, Math.trunc(target)), stat.lineCount)
      const top = layout
        ? scrollTopForLineIn(layout, line, viewport)
        : scrollTopForLine(line, stat.lineCount, viewport, scrollModel(stat.lineCount).scale)
      scrollTopRef.current = top
      setScrollTop(top)
      if (scrollRef.current) scrollRef.current.scrollTop = top
      setFlashLine(line - 1)
      if (flashTimer.current) window.clearTimeout(flashTimer.current)
      flashTimer.current = window.setTimeout(() => setFlashLine(null), 1200)
    },
    [stat, layout, viewportHeight],
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
    const { first, last } = view
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
    view,
    version,
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
        <PathBar path={path} externalRoot={externalRoot} onUseExternalRoot={onUseExternalRoot} onClose={onClose} />
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
        <PathBar path={path} externalRoot={externalRoot} onUseExternalRoot={onUseExternalRoot} onClose={onClose} />
        <div className="editor-empty">读取中…</div>
      </div>
    )
  }

  const image = isImagePath(path)
  const markdown = isMarkdownPath(path) && !stat.binary
  const html = isHtmlPath(path) && !stat.binary
  // Markdown 用 react-markdown，HTML 用 iframe：两者共用「预览/源码」切换。
  const previewable = markdown || html

  return (
    <div className="editor" ref={zoomHostRef}>
      <PathBar path={path} externalRoot={externalRoot} onUseExternalRoot={onUseExternalRoot} onClose={onClose} />
      <CodeToolbar
        stat={stat}
        previewable={previewable}
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
        wrap={wrap}
        onWrap={toggleWrap}
        zoom={viewZoom.zoom}
        onZoomIn={viewZoom.zoomIn}
        onZoomOut={viewZoom.zoomOut}
        onZoomReset={viewZoom.resetZoom}
        onZoomFit={isImage ? viewZoom.resetZoom : undefined}
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
            zoom={viewZoom.zoom}
          />
        )
      ) : image ? (
        imageError ? (
          <div className="editor-image">
            <div className="editor-error">{imageError}</div>
          </div>
        ) : imageUrl ? (
          <EditorImage src={imageUrl} alt={path} zoom={viewZoom.zoom} />
        ) : (
          <div className="editor-image">
            <div className="editor-empty">加载图片…</div>
          </div>
        )
      ) : stat.binary ? (
        <div className="editor-hex" style={viewZoom.zoom !== 1 ? { zoom: viewZoom.zoom } : undefined}>
          <div className="editor-note">二进制文件，显示前 4 KB 的十六进制内容。</div>
          <pre className="hex-dump">{hexError ?? hex ?? '读取中…'}</pre>
        </div>
      ) : stat.size === 0 ? (
        // 空文件统一给一句提示：空 HTML/Markdown 走预览只会是一片空白，看不出是没内容还是没加载。
        <div className="editor-empty">空文件</div>
      ) : previewable && mode === 'preview' ? (
        html ? (
          <div className="editor-html" style={viewZoom.zoom !== 1 ? { zoom: viewZoom.zoom } : undefined}>
            {previewError ? (
              <div className="editor-note">{previewError}</div>
            ) : preview === null ? (
              <div className="editor-empty">渲染中…</div>
            ) : (
              <iframe
                className="editor-frame"
                title={path}
                // 沙盒不给 allow-same-origin：脚本照常执行，但拿不到父页面的 token
                // 与 localStorage，避免「打开一个 HTML 就能调本地服务」。
                // 代价是页面里的相对资源（外部 css/图片）加载不出来，切「源码」可看原文。
                sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
                srcDoc={preview}
              />
            )}
          </div>
        ) : (
          <div
            className="editor-preview"
            onDoubleClick={startEdit}
            title="双击编辑"
            style={viewZoom.zoom !== 1 ? { zoom: viewZoom.zoom } : undefined}
          >
            {previewError ? (
              <div className="editor-note">{previewError}</div>
            ) : preview === null ? (
              <div className="editor-empty">渲染中…</div>
            ) : (
              <MarkdownText text={preview} onOpenFile={onOpenFile} />
            )}
          </div>
        )
      ) : stat.lineCount === 0 ? (
        <div className="editor-empty">空文件</div>
      ) : (
        <CodeSourceBody
          stat={stat}
          cache={cacheRef.current}
          first={view.first}
          last={view.last}
          topPad={view.topPad}
          bottomPad={view.bottomPad}
          wrap={wrapActive}
          rowsOf={rowsOf}
          onMeasured={handleMeasured}
          isMeasured={isMeasured}
          onScroll={onScroll}
          attachScroll={attachScroll}
          flashLine={flashLine}
          query={searchOpen ? query.trim() : ''}
          matchLine={searchOpen ? matches[matchIndex]?.line ?? null : null}
          onRetryPage={retryPage}
          onDoubleClick={startEdit}
          zoom={viewZoom.zoom}
        />
      )}
    </div>
  )
}
