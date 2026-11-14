import { useState, type RefObject } from 'react'
import type { FileStat } from '../api/localfs'
import { formatBytes } from './codeWindow'
import ViewZoomBar from './ViewZoomBar'

type Props = {
  stat: FileStat
  /** 有「预览」视图的格式（Markdown / HTML）：显示预览/源码切换。 */
  previewable: boolean
  mode: 'source' | 'preview'
  onMode: (mode: 'source' | 'preview') => void
  /** 源码模式下跳转到 1 基行号。 */
  onJump: (line: number) => void
  /** 视口首行（1 基）；null 表示当前不是可跳转的源码视图。 */
  currentLine: number | null
  /** 供 Ctrl+G 聚焦的输入框。 */
  jumpRef: RefObject<HTMLInputElement>
  /** 当前文件能否编辑（二进制 / 超大文件不行）。 */
  canEdit: boolean
  /** 不能编辑时的原因，作为悬浮提示。 */
  editHint: string | null
  editing: boolean
  dirty: boolean
  saving: boolean
  /** 保存编码（编辑时可改）。 */
  encoding: string
  /** 非编辑态是否显示「自动」（以指定编码重新打开）。 */
  allowAuto: boolean
  onEncoding: (encoding: string) => void
  onSave: () => void
  onCancel: () => void
  /** 自动换行是否开启（长行折行显示）。 */
  wrap: boolean
  onWrap: () => void
  /** 查看区缩放（只影响中栏，与整块界面缩放无关）。不传就不显示缩放条。 */
  zoom?: number
  onZoomIn?: () => void
  onZoomOut?: () => void
  onZoomReset?: () => void
  /** 图片视图才有：缩到刚好放得下。 */
  onZoomFit?: () => void
}

/** 编辑器顶部的文件信息条：大小 / 行数 / 编码 / 跳转 / 双击编辑 / 保存编码。 */
export default function CodeToolbar({
  stat,
  previewable,
  mode,
  onMode,
  onJump,
  currentLine,
  jumpRef,
  canEdit,
  editHint,
  editing,
  dirty,
  saving,
  encoding,
  allowAuto,
  onEncoding,
  onSave,
  onCancel,
  wrap,
  onWrap,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onZoomFit,
}: Props) {
  const [jumpText, setJumpText] = useState('')
  const canJump = !stat.binary && stat.lineCount > 0 && mode === 'source' && !editing

  function submitJump() {
    const value = Number(jumpText)
    if (!Number.isFinite(value) || value < 1) return
    onJump(Math.trunc(value))
  }

  return (
    <div className="editor-toolbar">
      <span className="editor-meta">{formatBytes(stat.size)}</span>
      <span className="editor-meta">
        {stat.lineCount > 0 ? `${stat.lineCount.toLocaleString('en-US')} 行` : '无文本行'}
      </span>
      <span className="editor-meta">{stat.encoding.toUpperCase()}</span>
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
      {dirty ? <span className="editor-dirty">● 未保存</span> : null}
      {stat.binary || editing || mode !== 'source' ? null : (
        <button
          type="button"
          className={`editor-wrap-toggle${wrap ? ' active' : ''}`}
          onClick={onWrap}
          title={
            wrap
              ? '自动换行：长行折到容器宽度内（Alt+Z 或点击改回单行）'
              : '单行显示：长行横向滚动（Alt+Z 或点击开启自动换行）'
          }
          aria-pressed={wrap}
        >
          换行
        </button>
      )}
      {stat.binary ? null : (
        <select
          className="editor-enc"
          value={encoding}
          onChange={(event) => onEncoding(event.target.value)}
          disabled={saving}
          title={
            editing
              ? '保存编码（换编码保存会让文件变成该编码）'
              : '以该编码重新打开（自动 = 按 BOM / 内容判定）'
          }
          aria-label="编码"
        >
          {allowAuto ? <option value="auto">自动</option> : null}
          <option value="utf8">UTF-8</option>
          <option value="utf16le">UTF-16 LE</option>
          <option value="utf16be">UTF-16 BE</option>
          <option value="gbk">GBK</option>
        </select>
      )}
      {editing ? (
        <span className="editor-actions">
          <button
            type="button"
            className="editor-action primary"
            onClick={onSave}
            disabled={saving || !dirty}
            title="保存（Ctrl+S）"
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className="editor-action"
            onClick={onCancel}
            disabled={saving}
            title="放弃修改（Esc）"
          >
            取消
          </button>
        </span>
      ) : (
        <span
          className={`editor-edit-hint${canEdit ? '' : ' muted'}`}
          title={editHint ?? '双击代码进入编辑（Ctrl+S 保存）'}
        >
          {canEdit ? '双击编辑' : '只读'}
        </span>
      )}
      {previewable && !editing ? (
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
      {zoom !== undefined && onZoomIn && onZoomOut && onZoomReset ? (
        <ViewZoomBar
          zoom={zoom}
          onZoomIn={onZoomIn}
          onZoomOut={onZoomOut}
          onReset={onZoomReset}
          onFit={onZoomFit}
        />
      ) : null}
    </div>
  )
}
