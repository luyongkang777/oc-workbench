import { zoomLabel, VIEW_ZOOM } from './viewZoom'

type Props = {
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onReset: () => void
  /** 图片视图才有「适应窗口」：把图缩到刚好放得下。 */
  onFit?: () => void
}

/**
 * 查看区的缩放控件：`−` `100%` `+` `适应`。
 *
 * 放在编辑器工具栏最右侧，只影响中间这块查看区，不动整块界面。
 * 点百分比 = 复位到 100%（按了总有反应，即使已经是 100%）。
 */
export default function ViewZoomBar({ zoom, onZoomIn, onZoomOut, onReset, onFit }: Props) {
  const atMin = zoom <= VIEW_ZOOM.min + 0.001
  const atMax = zoom >= VIEW_ZOOM.max - 0.001

  return (
    <span className="view-zoom" role="group" aria-label="查看区缩放">
      <button
        type="button"
        className="view-zoom-btn"
        onClick={onZoomOut}
        disabled={atMin}
        title="缩小（Ctrl+-，也可在查看区按 Ctrl+滚轮）"
        aria-label="缩小"
      >
        −
      </button>
      <button
        type="button"
        className={`view-zoom-value${zoom === VIEW_ZOOM.def ? '' : ' active'}`}
        onClick={onReset}
        title="当前缩放，点击回到 100%（Ctrl+0）"
      >
        {zoomLabel(zoom)}
      </button>
      <button
        type="button"
        className="view-zoom-btn"
        onClick={onZoomIn}
        disabled={atMax}
        title="放大（Ctrl+=，也可在查看区按 Ctrl+滚轮）"
        aria-label="放大"
      >
        +
      </button>
      {onFit ? (
        <button
          type="button"
          className="view-zoom-fit"
          onClick={onFit}
          title="适应窗口：把这张图缩到刚好放得下"
        >
          适应
        </button>
      ) : null}
    </span>
  )
}
