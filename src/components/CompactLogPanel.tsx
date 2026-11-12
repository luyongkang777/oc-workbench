import { useState } from 'react'
import {
  compactSummary,
  formatDuration,
  recordSize,
  shortTime,
  type CompactRecord,
} from './compactLog'

type Props = {
  records: CompactRecord[]
  onClear?: () => void
}

/**
 * 会话里的压缩记录（折叠）。
 *
 * 放在消息流末尾：压缩把历史重写掉之后，这是唯一还能说明「这里发生过什么」的
 * 东西。默认收起，只露一行摘要；展开看每次的时间、前后 token、耗时和失败原因。
 */
export default function CompactLog({ records, onClear }: Props) {
  const [open, setOpen] = useState(false)
  if (records.length === 0) return null

  // 新的在上：最近一次压缩是最常被回看的
  const rows = [...records].reverse()

  return (
    <div className={`chat-compact-log${open ? ' open' : ''}`}>
      <button
        type="button"
        className="chat-compact-log-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="chat-compact-log-caret">{open ? '▾' : '▸'}</span>
        <span className="chat-compact-log-title">{compactSummary(records)}</span>
        <span className="chat-compact-log-hint">{open ? '收起' : '展开'}</span>
      </button>

      {open ? (
        <div className="chat-compact-log-body">
          {rows.map((record, index) => (
            <div
              className={`chat-compact-log-row${record.ok ? '' : ' fail'}`}
              // 同一毫秒压两次的极端情况也要有稳定 key
              key={`${record.at}-${record.ms}-${index}`}
            >
              <span className="chat-compact-log-time">{shortTime(record.at)}</span>
              <span className="chat-compact-log-size">{recordSize(record)}</span>
              <span className="chat-compact-log-ms">{formatDuration(record.ms)}</span>
              {record.error ? (
                <span className="chat-compact-log-err" title={record.error}>
                  {record.error}
                </span>
              ) : null}
            </div>
          ))}
          {onClear ? (
            <button type="button" className="chat-compact-log-clear" onClick={onClear}>
              清空记录
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
