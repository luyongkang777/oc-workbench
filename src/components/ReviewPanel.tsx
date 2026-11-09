import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { fetchDiff, fetchStatus, type FileDiff, type FileStatus } from '../api/vcs'

type Props = {
  root: string
  connected: boolean
}

const STATUS_MARK: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
}

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

function PatchBody({ patch }: { patch: string }) {
  const lines = useMemo(() => patch.split('\n'), [patch])
  return (
    <pre className="diff-body">
      {lines.map((line, index) => (
        <div className={`diff-line ${lineClass(line)}`} key={index}>
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}

export default function ReviewPanel({ root, connected }: Props) {
  const [status, setStatus] = useState<FileStatus[]>([])
  const [diffs, setDiffs] = useState<FileDiff[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // root 变化或组件卸载后，在途请求的结果一律丢弃（防止旧目录 diff 覆盖新目录）
  const genRef = useRef(0)

  const reload = useCallback(async () => {
    if (!connected) return
    const gen = ++genRef.current
    setLoading(true)
    try {
      const [nextStatus, nextDiffs] = await Promise.all([fetchStatus(root), fetchDiff(root)])
      if (gen !== genRef.current) return
      setStatus(nextStatus)
      setDiffs(nextDiffs)
      setError(null)
      setSelected((current) => {
        if (current && nextDiffs.some((item) => item.file === current)) return current
        return nextDiffs[0]?.file ?? null
      })
    } catch (err) {
      if (gen !== genRef.current) return
      setError((err as Error).message)
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [connected, root])

  useEffect(() => {
    void reload()
    return () => {
      genRef.current += 1
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
        <button type="button" className="review-refresh" onClick={() => void reload()} disabled={loading}>
          {loading ? '刷新中' : '刷新'}
        </button>
      </div>

      {error ? <div className="review-error">{error}</div> : null}

      <div className="review-main">
        <div className="review-list">
          {diffs.length === 0 ? (
            <div className="review-empty">{connected ? '没有未提交的改动' : '等待后端连接…'}</div>
          ) : (
            diffs.map((item) => {
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
            })
          )}
        </div>

        <div className="review-diff">
          {current ? (
            <>
              <div className="review-diff-head" title={current.file}>
                {current.file}
              </div>
              <div className="diff-scroll">
                <PatchBody patch={current.patch} />
              </div>
            </>
          ) : (
            <div className="review-empty">选择左侧文件查看改动</div>
          )}
        </div>
      </div>
    </div>
  )
}
