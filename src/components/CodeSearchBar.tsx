import type { RefObject } from 'react'

type Props = {
  query: string
  onQuery: (value: string) => void
  count: number
  active: number
  truncated: boolean
  searching: boolean
  error: string | null
  onPrev: () => void
  onNext: () => void
  onClose: () => void
  inputRef: RefObject<HTMLInputElement>
}

/** Ctrl+F 打开的整文件搜索条：命中计数 + 上一个/下一个 + 关闭。 */
export default function CodeSearchBar({
  query,
  onQuery,
  count,
  active,
  truncated,
  searching,
  error,
  onPrev,
  onNext,
  onClose,
  inputRef,
}: Props) {
  let status: string
  if (error) status = error
  else if (searching) status = '搜索中…'
  else if (count === 0) status = query.trim() ? '无匹配' : '输入关键词'
  else status = `${active + 1}/${count}${truncated ? '+' : ''}`

  return (
    <div className="editor-search">
      <input
        ref={inputRef}
        className="editor-search-input"
        value={query}
        placeholder="在当前文件搜索（回车下一个，Shift+回车上一个）"
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) onPrev()
            else onNext()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
        aria-label="在当前文件搜索"
      />
      <span className={`editor-search-count${error ? ' error' : ''}`}>{status}</span>
      <button
        type="button"
        className="editor-search-btn"
        onClick={onPrev}
        disabled={count === 0}
        title="上一个（Shift+Enter）"
      >
        ↑
      </button>
      <button
        type="button"
        className="editor-search-btn"
        onClick={onNext}
        disabled={count === 0}
        title="下一个（Enter）"
      >
        ↓
      </button>
      <button
        type="button"
        className="editor-search-btn editor-search-close"
        onClick={onClose}
        title="关闭（Esc）"
      >
        ×
      </button>
    </div>
  )
}
