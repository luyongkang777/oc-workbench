import { useCallback, useEffect, useRef, useState } from 'react'
import { readLines, searchFile, statFile, type FileStat, type SearchMatch } from '../api/localfs'
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

type Props = {
  root: string
  path: string | null
  /** 每次点文件自增：点同一个文件也能强制重读。 */
  openSeq: number
  /** 打开后要跳到的行（1 基）；null 表示不跳。 */
  openLine?: number | null
  /** 预览里的 Markdown 若含文件路径，点开别的文件。 */
  onOpenFile?: (path: string, line?: number) => void
}

/**
 * 代码/文档查看器：任意大小文件都只看「视口里的几十行」。
 *
 * 数据流：stat（行数 + 编码 + 是否二进制）→ 按行分页按需取。
 * 服务端可能因为 512KB 上限少给几行，所以每页记 `next`，缺口从 next 续拉，
 * 不能假设「一页就是 200 行」。快速连点文件时 abort 所有在途页请求，旧响应凭 gen 丢弃。
 */
export default function CodeView({ root, path, openSeq, openLine, onOpenFile }: Props) {
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

  const bump = useCallback(() => setVersion((value) => value + 1), [])
  searchOpenRef.current = searchOpen
  statRef.current = stat
  const previewState = useFilePreview(root, path, stat)
  const { mode, setMode, preview, previewError, hex, hexError, imageUrl, imageError } = previewState

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
    statFile(root, path, controller.signal)
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
  }, [root, path, openSeq, reload])

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
      readLines(root, path ?? '', start, WINDOW_LINES, controller.signal)
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
    [root, path, bump],
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

  // Ctrl+G 跳转聚焦 / Ctrl+F 打开搜索 / Esc 关闭搜索。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        if (event.key === 'Escape' && searchOpenRef.current) setSearchOpen(false)
        return
      }
      const key = event.key.toLowerCase()
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
  }, [setMode])

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
      searchFile(root, path, keyword, 500, controller.signal)
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
  }, [searchOpen, query, path, root, stat])

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
        <div className="editor-path" title={path}>
          {path}
        </div>
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
        <div className="editor-path" title={path}>
          {path}
        </div>
        <div className="editor-empty">读取中…</div>
      </div>
    )
  }

  const image = isImagePath(path)
  const markdown = isMarkdownPath(path) && !stat.binary

  return (
    <div className="editor">
      <div className="editor-path" title={path}>
        {path}
      </div>
      <CodeToolbar
        stat={stat}
        markdown={markdown}
        mode={mode}
        onMode={setMode}
        onJump={jumpToLine}
        currentLine={currentLine}
        jumpRef={jumpRef}
      />
      {searchOpen ? (
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

      {image ? (
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
        <div className="editor-preview">
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
        />
      )}
    </div>
  )
}
