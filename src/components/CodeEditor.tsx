import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { listDirLocal, readText } from '../api/localfs'
import {
  applyCompletion,
  buildCandidates,
  caretLineCol,
  collectSymbols,
  isCodeLang,
  languageOf,
  popupPlacement,
  readContext,
  shouldAutoTrigger,
  type Candidate,
  type CompletionContext,
  type PathEntry,
  type SymbolInfo,
} from './completion'

/** 与源码视图保持一致：行高固定，未开启自动换行时一行 = 一个视觉行。 */
const LINE_HEIGHT = 19
const TAB_WIDTH = 2
/** 补全浮层最多显示多少条（键盘上下翻的就是这些） */
const POPUP_ROWS = 9
/** 同目录最多索引多少个文件，单个文件多大就不读了 */
const INDEX_FILE_LIMIT = 40
const INDEX_FILE_MAX_BYTES = 128 * 1024
/** 打字停下多久重算当前文件符号 */
const SYMBOL_DEBOUNCE_MS = 200
/** 超过这个大小的文件不在打字时重算符号（只靠挂载时那一份） */
const SYMBOL_LIVE_MAX = 400 * 1024

type Props = {
  text: string
  onChange: (text: string) => void
  /** Ctrl/Cmd+S */
  onSave: () => void
  /** Esc / 取消按钮 */
  onCancel: () => void
  saving: boolean
  /** 工作区根目录与当前文件（相对 root），用来索引同目录符号与 import 路径 */
  root?: string
  path?: string
}

type Popup = {
  items: Candidate[]
  index: number
  ctx: CompletionContext
  left: number
  top: number
}

type WorkspaceIndex = { entries: PathEntry[]; symbols: Candidate[] }

const EMPTY_INDEX: WorkspaceIndex = { entries: [], symbols: [] }

/**
 * 整份文本编辑器：左侧行号与 textarea 共用行高，滚动时只渲染视口内的行号。
 *
 * 不做语法高亮（大文件下会把输入拖慢），保证 2MB 文件打字不卡。
 * 行号用绝对定位 + 滚动偏移，所以不需要渲染几万行 DOM。
 *
 * 补全：本地符号 + 同目录符号 + 关键字 + import 路径，Tab/Enter 接受、Esc 关闭、
 * Ctrl+Space 手动叫出。不依赖语言服务器，跨语言都能用。
 */
export default function CodeEditor({ text, onChange, onSave, onCancel, saving, root, path = '' }: Props) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(600)
  const [popup, setPopup] = useState<Popup | null>(null)
  const [index, setIndex] = useState<WorkspaceIndex>(EMPTY_INDEX)

  const lang = useMemo(() => languageOf(path), [path])
  const symbolsRef = useRef<SymbolInfo[]>([])
  const charWidthRef = useRef(7.5)

  useEffect(() => {
    const node = areaRef.current
    if (!node) return
    node.focus()
    node.setSelectionRange(0, 0)
    node.scrollTop = 0
    const update = () => setViewport(node.clientHeight || 600)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // 等宽字体的字符宽度：浮层要按列定位，只能量一次真实字体
  useEffect(() => {
    const node = areaRef.current
    if (!node) return
    const style = getComputedStyle(node)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.font = `${style.fontSize} ${style.fontFamily}`
    const width = ctx.measureText('0'.repeat(20)).width / 20
    if (width > 1) charWidthRef.current = width
  }, [])

  // 当前文件符号：挂载时算一份，之后打字停下再算（不放进 state，避免每次按键重渲染）
  useEffect(() => {
    symbolsRef.current = isCodeLang(lang) ? collectSymbols(text, lang) : []
    // 只在挂载 / 切换文件时算一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang])

  useEffect(() => {
    if (!isCodeLang(lang)) return
    const timer = setTimeout(() => {
      symbolsRef.current = text.length <= SYMBOL_LIVE_MAX ? collectSymbols(text, lang) : symbolsRef.current
    }, SYMBOL_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text, lang])

  // 同目录索引：跨文件符号 + import 路径候选
  useEffect(() => {
    if (!root || !path || !isCodeLang(lang)) {
      setIndex(EMPTY_INDEX)
      return
    }
    const dir = dirOf(path)
    const controller = new AbortController()
    let cancelled = false

    ;(async () => {
      try {
        const entries = await listDirLocal(root, dir, controller.signal)
        if (cancelled) return
        const pathEntries: PathEntry[] = entries
          .map((entry) => ({ name: baseName(entry.path), isDir: entry.type === 'directory' }))
          .filter((entry) => !!entry.name)

        const files = entries
          .filter(
            (entry) =>
              entry.type === 'file' &&
              entry.path !== path &&
              isCodeLang(languageOf(entry.path)) &&
              (entry.size ?? 0) <= INDEX_FILE_MAX_BYTES,
          )
          .slice(0, INDEX_FILE_LIMIT)

        const texts = await Promise.all(
          files.map(async (entry) => {
            try {
              return { path: entry.path, text: await readText(root, entry.path, INDEX_FILE_MAX_BYTES, null, controller.signal) }
            } catch {
              return null
            }
          }),
        )
        if (cancelled) return

        const seen = new Set<string>()
        const symbols: Candidate[] = []
        for (const file of texts) {
          if (!file) continue
          const name = baseName(file.path)
          for (const sym of collectSymbols(file.text, languageOf(file.path))) {
            const key = `${sym.name}@${name}`
            if (seen.has(key)) continue
            seen.add(key)
            symbols.push({ label: sym.name, kind: 'workspace', detail: name, score: 12 })
          }
        }
        setIndex({ entries: pathEntries, symbols: symbols.slice(0, 600) })
      } catch {
        if (!cancelled) setIndex(EMPTY_INDEX)
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [root, path, lang])

  const lineCount = useMemo(() => countLines(text), [text])

  const first = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT))
  const visible = Math.ceil(viewport / LINE_HEIGHT) + 2
  const last = Math.min(lineCount - 1, first + visible)
  const numbers: number[] = []
  for (let line = first; line <= last; line += 1) numbers.push(line)

  const onScroll = useCallback(() => {
    const node = areaRef.current
    if (node) setScrollTop(node.scrollTop)
    // 滚动后浮层位置会飘，直接关掉，下一次按键再弹
    setPopup(null)
  }, [])

  /** 打开补全：算上下文 → 组候选 → 定位浮层。 */
  const open = useCallback(
    (value: string, caret: number, options: { manual?: boolean; auto?: boolean; prevChar?: string } = {}) => {
      const node = areaRef.current
      if (!node) return
      const ctx = readContext(value, caret)
      if (!options.manual) {
        if (!options.auto) return
        if (!shouldAutoTrigger(options.prevChar ?? '', ctx)) {
          setPopup(null)
          return
        }
      }

      const items = buildCandidates({
        lang,
        ctx,
        local: symbolsRef.current,
        workspace: index.symbols,
        entries: index.entries,
        manual: options.manual === true,
      })
      if (items.length === 0) {
        setPopup(null)
        return
      }

      const { line, col } = caretLineCol(value, caret)
      const wrap = wrapRef.current
      const place = popupPlacement({
        line,
        col,
        charWidth: charWidthRef.current,
        scrollTop: node.scrollTop,
        scrollLeft: node.scrollLeft,
        paneWidth: wrap?.clientWidth || node.clientWidth || 0,
        paneHeight: wrap?.clientHeight || viewport,
        rows: items.length,
      })

      setPopup({ items, index: 0, ctx, left: place.left, top: place.top })
    },
    [index, lang, viewport],
  )

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const key = event.key.toLowerCase()

    // ---------- 补全优先 ----------
    if (popup) {
      if (key === 'arrowdown') {
        event.preventDefault()
        event.stopPropagation()
        setPopup({ ...popup, index: (popup.index + 1) % popup.items.length })
        return
      }
      if (key === 'arrowup') {
        event.preventDefault()
        event.stopPropagation()
        setPopup({ ...popup, index: (popup.index - 1 + popup.items.length) % popup.items.length })
        return
      }
      if (key === 'pagedown' || key === 'pageup') {
        event.preventDefault()
        const delta = key === 'pagedown' ? POPUP_ROWS : -POPUP_ROWS
        const next = Math.max(0, Math.min(popup.items.length - 1, popup.index + delta))
        setPopup({ ...popup, index: next })
        return
      }
      if (key === 'enter' || key === 'tab') {
        event.preventDefault()
        event.stopPropagation()
        accept(popup.items[popup.index])
        return
      }
      if (event.key === 'Escape') {
        // 只关浮层，不退出编辑
        event.preventDefault()
        event.stopPropagation()
        setPopup(null)
        return
      }
    }

    // ---------- 手动触发 ----------
    if ((event.ctrlKey || event.metaKey) && event.code === 'Space') {
      event.preventDefault()
      event.stopPropagation()
      const node = event.currentTarget
      open(text, node.selectionStart ?? text.length, { manual: true })
      return
    }

    if ((event.ctrlKey || event.metaKey) && key === 's') {
      // 不再冒泡到窗口级 Ctrl+S，否则会保存两次
      event.preventDefault()
      event.stopPropagation()
      if (!saving) onSave()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      const node = event.currentTarget
      const start = node.selectionStart
      const end = node.selectionEnd
      onChange(`${text.slice(0, start)}${' '.repeat(TAB_WIDTH)}${text.slice(end)}`)
      // 受控组件：等 React 写回 value 再恢复光标，否则会被拉回末尾
      requestAnimationFrame(() => {
        node.setSelectionRange(start + TAB_WIDTH, start + TAB_WIDTH)
      })
    }
  }

  /** 接受候选：替换上下文区间，光标落在插入内容之后。 */
  function accept(cand: Candidate) {
    if (!popup) return
    const result = applyCompletion(text, popup.ctx, cand)
    setPopup(null)
    onChange(result.text)
    requestAnimationFrame(() => {
      const node = areaRef.current
      if (!node) return
      node.focus()
      node.setSelectionRange(result.caret, result.caret)
    })
  }

  // 当前项滚进可视区
  useEffect(() => {
    if (!popup || !listRef.current) return
    const node = listRef.current.children[popup.index] as HTMLElement | undefined
    node?.scrollIntoView({ block: 'nearest' })
  }, [popup])

  return (
    <div className="code-edit" ref={wrapRef}>
      <div className="code-edit-gutter" aria-hidden="true">
        {numbers.map((line) => (
          <div
            className="code-edit-no"
            key={line}
            style={{ top: line * LINE_HEIGHT - scrollTop }}
          >
            {line + 1}
          </div>
        ))}
      </div>
      <textarea
        ref={areaRef}
        className="code-edit-area"
        value={text}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        aria-label="文件内容"
        onChange={(event) => {
          const value = event.target.value
          const caret = event.target.selectionStart ?? value.length
          onChange(value)
          open(value, caret, { auto: true, prevChar: value[caret - 1] ?? '' })
        }}
        onKeyDown={onKeyDown}
        onScroll={onScroll}
        onBlur={() => setPopup(null)}
      />
      {popup ? (
        <div
          className="code-complete"
          style={{ left: popup.left, top: popup.top }}
          role="listbox"
          onMouseDown={(event) => event.preventDefault()}
        >
          <div className="code-complete-head">
            <span>{popupHead(popup.ctx)}</span>
            <span className="code-complete-hint">Tab 接受 · Esc 关闭</span>
          </div>
          <div className="code-complete-list" ref={listRef}>
            {popup.items.map((item, i) => (
              <div
                key={`${item.label}-${i}`}
                className={`code-complete-item${i === popup.index ? ' active' : ''}`}
                onMouseEnter={() => setPopup((cur) => (cur ? { ...cur, index: i } : cur))}
                onMouseDown={(event) => {
                  event.preventDefault()
                  accept(item)
                }}
              >
                <span className={`code-complete-kind ${item.kind}`}>{kindBadge(item.kind)}</span>
                <span className="code-complete-label">{item.label}</span>
                {item.detail ? <span className="code-complete-detail">{item.detail}</span> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function popupHead(ctx: CompletionContext): string {
  if (ctx.mode === 'path') return '路径补全'
  if (ctx.mode === 'member') return '成员'
  return ctx.prefix ? `补全「${ctx.prefix}」` : '补全'
}

function kindBadge(kind: Candidate['kind']): string {
  switch (kind) {
    case 'local':
      return '本'
    case 'workspace':
      return '库'
    case 'keyword':
      return 'kw'
    case 'path':
      return '／'
    default:
      return '·'
  }
}

function dirOf(path: string): string {
  const normalized = String(path ?? '').replace(/\\/g, '/')
  const cut = normalized.lastIndexOf('/')
  return cut < 0 ? '' : normalized.slice(0, cut)
}

function baseName(path: string): string {
  const normalized = String(path ?? '').replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function countLines(text: string): number {
  if (text === '') return 1
  let count = 1
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1
  }
  return count
}
