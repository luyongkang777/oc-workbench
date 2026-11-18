import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchDiff, fetchStatus, type FileDiff, type FileStatus } from '../api/vcs'
import DiffBody from './DiffBody'
import { readWrapPref, writeWrapPref } from './wrapPrefs'

type Props = {
  root: string
  connected: boolean
}

/**
 * 列表项高度：必须和 styles/diff.css 的 `.review-item` 完全一致
 * （虚拟化靠它算位移，差 1px 都会越滚越偏）。
 */
const ITEM_HEIGHT = 26
/** 文件列表上下各多渲染几项 */
const ITEM_OVERSCAN = 8

const STATUS_MARK: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
}

export default function ReviewPanel({ root, connected }: Props) {
  const [status, setStatus] = useState<FileStatus[]>([])
  const [diffs, setDiffs] = useState<FileDiff[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 自动换行：和文件查看器共用一份偏好（按项目根记忆）
  const [wrap, setWrap] = useState(() => readWrapPref(root))
  // root 变化或组件卸载后，在途请求的结果一律丢弃（防止旧目录 diff 覆盖新目录）
  const genRef = useRef(0)
  // 上一轮请求：连点刷新时先掐掉，不然几 MB 的 diff 会堆成一串
  const abortRef = useRef<AbortController | null>(null)
  // 文件列表虚拟滚动：几千个改动时不能把每个都塞进 DOM
  const listRef = useRef<HTMLDivElement | null>(null)
  const listRaf = useRef(0)
  const [listScrollTop, setListScrollTop] = useState(0)
  const [listViewport, setListViewport] = useState(600)

  useEffect(() => {
    setWrap(readWrapPref(root))
  }, [root])

  const toggleWrap = useCallback(() => {
    setWrap((cur) => {
      const next = !cur
      writeWrapPref(root, next)
      return next
    })
  }, [root])

  // Alt+Z：和文件查看器同一个快捷键。两个面板同时只挂载一个，不会重复触发。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key.toLowerCase() !== 'z') return
      event.preventDefault()
      toggleWrap()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleWrap])

  const reload = useCallback(async () => {
    if (!connected) {
      // 断开时不能把 loading 卡在 true：旧请求的 finally 会因代际不匹配跳过复位。
      genRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
      setLoading(false)
      return
    }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const gen = ++genRef.current
    setLoading(true)
    try {
      const [nextStatus, nextDiffs] = await Promise.all([
        fetchStatus(root, controller.signal),
        fetchDiff(root, controller.signal),
      ])
      if (gen !== genRef.current || controller.signal.aborted) return
      setStatus(nextStatus)
      setDiffs(nextDiffs)
      setError(null)
      setSelected((current) => {
        if (current && nextDiffs.some((item) => item.file === current)) return current
        return nextDiffs[0]?.file ?? null
      })
    } catch (err) {
      if (gen !== genRef.current || controller.signal.aborted) return
      setError((err as Error).message)
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [connected, root])

  useEffect(() => {
    const node = listRef.current
    if (!node) return
    const update = () => setListViewport(node.clientHeight || 600)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => {
      observer.disconnect()
      if (listRaf.current) cancelAnimationFrame(listRaf.current)
    }
  }, [])

  const onListScroll = useCallback(() => {
    if (listRaf.current) return
    listRaf.current = requestAnimationFrame(() => {
      listRaf.current = 0
      if (listRef.current) setListScrollTop(listRef.current.scrollTop)
    })
  }, [])

  useEffect(() => {
    // root 换了先清空旧目录的数据：新目录加载慢或失败时，不能还挂着旧仓库的改动。
    setStatus([])
    setDiffs([])
    setSelected(null)
    setError(null)
    void reload()
    return () => {
      genRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [reload])

  const current = diffs.find((item) => item.file === selected)
  const statusOf = (file: string) => status.find((item) => item.file === file)

  return (
    <div className="review">
      <div className="review-head">
        <span className="review-title">工作区改动</span>
        <span className="review-count">{diffs.length} 个文件</span>
        <span className="review-spacer" />
        <button
          type="button"
          className={`review-refresh${wrap ? ' active' : ''}`}
          onClick={toggleWrap}
          title={wrap ? '长行折行显示（Alt+Z）' : '长行横向滚动（Alt+Z）'}
          aria-pressed={wrap}
        >
          换行
        </button>
        <button type="button" className="review-refresh" onClick={() => void reload()} disabled={loading}>
          {loading ? '刷新中' : '刷新'}
        </button>
      </div>

      {error ? <div className="review-error">{error}</div> : null}

      <div className="review-main">
        <div className="review-list" ref={listRef} onScroll={onListScroll}>
          {diffs.length === 0 ? (
            <div className="review-empty">
              {!connected ? '等待后端连接…' : loading ? '读取改动中…' : '没有未提交的改动'}
            </div>
          ) : (
            (() => {
              const total = diffs.length
              const firstVisible = Math.floor(listScrollTop / ITEM_HEIGHT)
              const first = Math.max(0, firstVisible - ITEM_OVERSCAN)
              const count = Math.ceil(listViewport / ITEM_HEIGHT) + 1
              const last = Math.min(total, first + count + ITEM_OVERSCAN)
              return (
                <div style={{ height: total * ITEM_HEIGHT, position: 'relative' }}>
                  <div style={{ transform: `translateY(${first * ITEM_HEIGHT}px)` }}>
                    {diffs.slice(first, last).map((item) => {
                      const info = statusOf(item.file)
                      const mark = STATUS_MARK[info?.status ?? 'modified'] ?? 'M'
                      return (
                        <button
                          key={item.file}
                          type="button"
                          className={`review-item${item.file === selected ? ' active' : ''}`}
                          onClick={() => setSelected(item.file)}
                          title={item.file}
                        >
                          <span className={`review-mark ${mark.toLowerCase()}`}>{mark}</span>
                          <span className="review-file">{item.file}</span>
                          <span className="review-stat">
                            <span className="add">+{item.additions}</span>
                            <span className="del">-{item.deletions}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })()
          )}
        </div>

        <div className="review-diff">
          {current ? (
            <>
              <div className="review-diff-head" title={current.file}>
                {current.file}
              </div>
              <DiffBody key={current.file} patch={current.patch} wrap={wrap} />
            </>
          ) : (
            <div className="review-empty">{loading ? '读取改动中…' : '选择左侧文件查看改动'}</div>
          )}
        </div>
      </div>
    </div>
  )
}
