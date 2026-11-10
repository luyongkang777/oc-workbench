import { useState, type RefObject } from 'react'
import type { FileStat } from '../api/localfs'
import { formatBytes } from './codeWindow'

type Props = {
  stat: FileStat
  markdown: boolean
  mode: 'source' | 'preview'
  onMode: (mode: 'source' | 'preview') => void
  /** 源码模式下跳转到 1 基行号。 */
  onJump: (line: number) => void
  /** 视口首行（1 基）；null 表示当前不是可跳转的源码视图。 */
  currentLine: number | null
  /** 供 Ctrl+G 聚焦的输入框。 */
  jumpRef: RefObject<HTMLInputElement>
}

/** 编辑器顶部的文件信息条：大小 / 行数 / 编码 / 跳转 / 预览切换。 */
export default function CodeToolbar({
  stat,
  markdown,
  mode,
  onMode,
  onJump,
  currentLine,
  jumpRef,
}: Props) {
  const [jumpText, setJumpText] = useState('')
  const canJump = !stat.binary && stat.lineCount > 0 && mode === 'source'

  function submitJump() {
    const value = Number(jumpText)
    if (!Number.isFinite(value) || value < 1) return
    onJump(Math.trunc(value))
  }

  return (
    <div className="editor-toolbar">
      <span>{formatBytes(stat.size)}</span>
      <span>
        {stat.lineCount > 0 ? `${stat.lineCount.toLocaleString('en-US')} 行` : '无文本行'}
      </span>
      <span>{stat.encoding.toUpperCase()}</span>
      {stat.binary ? <span>二进制</span> : null}
      {currentLine !== null ? (
        <span className="editor-current-line">第 {currentLine.toLocaleString('en-US')} 行</span>
      ) : null}
      {canJump ? (
        <span className="editor-jump">
          <input
            className="editor-jump-input"
            type="number"
            min={1}
            max={stat.lineCount}
            ref={jumpRef}
            placeholder="跳转到行"
            title="Ctrl+G 聚焦"
            value={jumpText}
            onChange={(event) => setJumpText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitJump()
              if (event.key === 'Escape') setJumpText('')
            }}
            aria-label="跳转到行号"
          />
          <button
            type="button"
            className="editor-jump-btn"
            onClick={submitJump}
            title="跳转到指定行（回车 / Ctrl+G）"
          >
            跳转
          </button>
        </span>
      ) : null}
      <span className="editor-toolbar-spacer" />
      {markdown ? (
        <span className="editor-modes">
          <button
            type="button"
            className={mode === 'preview' ? 'active' : ''}
            onClick={() => onMode('preview')}
          >
            预览
          </button>
          <button
            type="button"
            className={mode === 'source' ? 'active' : ''}
            onClick={() => onMode('source')}
          >
            源码
          </button>
        </span>
      ) : null}
    </div>
  )
}
