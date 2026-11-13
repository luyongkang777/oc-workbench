import { useEffect, useRef, useState } from 'react'

type Props = {
  src: string
  alt: string
  /** 100% = 适应窗口；>100% 在适应尺寸基础上放大，<100% 缩小。 */
  zoom: number
}

type Size = { w: number; h: number }

/**
 * 图片视图：按「适应窗口 × 缩放比例」算出真实尺寸，超出容器就滚动。
 *
 * 为什么不用 CSS `zoom`（实测结论）：
 *   * `zoom` 加在 `<img>` 上完全不生效；
 *   * 加在滚动容器上虽然能放大，但 `max-width:100%` 会把图恒压回容器大小，
 *     于是「放大了看不出变化」，还得另写一套尺寸计算。
 * 这里直接算像素：容器大小用 ResizeObserver 量、原图大小用 onLoad 拿，
 * 显示尺寸 = 原图 × min(1, 容器/原图) × 缩放。100% 因此天然等于「适应窗口」。
 *
 * 原图尺寸必须和 src 绑在一起存（不能换图时先清空）：缓存命中的图片
 * `onLoad` 可能早于 effect 执行，清空后就不会再有第二次 onLoad，图会退回原始大小不再缩放。
 */
export default function EditorImage({ src, alt, zoom }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [loaded, setLoaded] = useState<{ src: string; size: Size } | null>(null)
  const [box, setBox] = useState<Size>({ w: 0, h: 0 })

  // 容器尺寸：窗口拖动、左右栏拖宽都会变，必须跟着重算，否则「适应」不跟手
  useEffect(() => {
    const node = boxRef.current
    if (!node) return
    const update = () => {
      // 减掉 .editor-image 的左右/上下 padding（16px × 2）
      setBox({ w: Math.max(1, node.clientWidth - 32), h: Math.max(1, node.clientHeight - 32) })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // 只认「当前这张图」量到的尺寸；换了图就当没量过（等它自己的 onLoad）
  const natural = loaded && loaded.src === src ? loaded.size : { w: 0, h: 0 }

  let width: number | undefined
  let height: number | undefined
  if (natural.w > 0 && natural.h > 0 && box.w > 0 && box.h > 0) {
    // 小图不主动拉大（1:1 显示），大图缩到容器内 —— 这就是「适应窗口」
    const fit = Math.min(1, box.w / natural.w, box.h / natural.h)
    const scale = fit * zoom
    width = Math.max(1, Math.round(natural.w * scale))
    height = Math.max(1, Math.round(natural.h * scale))
  }

  return (
    <div className="editor-image" ref={boxRef}>
      <div className="editor-image-inner">
        <img
          src={src}
          alt={alt}
          style={width ? { width, height } : undefined}
          onLoad={(event) => {
            const img = event.currentTarget
            setLoaded({ src, size: { w: img.naturalWidth, h: img.naturalHeight } })
          }}
        />
      </div>
    </div>
  )
}
