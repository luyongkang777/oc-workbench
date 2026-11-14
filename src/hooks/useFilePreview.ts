import { useCallback, useEffect, useRef, useState } from 'react'
import { readHex, readRaw, readText, type FileStat } from '../api/localfs'
import {
  htmlPreviewNote,
  inlineLocalResources,
  type InlineResult,
} from '../components/htmlPreview'
import { formatBytes, isHtmlPath, isImagePath, isMarkdownPath } from '../components/codeWindow'

/** Markdown / HTML 全文预览上限：再大 react-markdown 或 iframe 自己就会卡。 */
const PREVIEW_MAX_BYTES = 1024 * 1024
/** 图片预览上限：超过就不加载，避免把内存吃光。 */
const IMAGE_MAX_BYTES = 64 * 1024 * 1024

export type PreviewMode = 'source' | 'preview'

export type FilePreview = {
  mode: PreviewMode
  setMode: (mode: PreviewMode) => void
  preview: string | null
  previewError: string | null
  /** HTML 预览的说明（沙盒限制 / 内联失败时的提示）；Markdown 为 null。 */
  htmlNote: string | null
  hex: string | null
  hexError: string | null
  imageUrl: string | null
  imageError: string | null
}

/**
 * Blob → 字节。
 *
 * 不直接 `readAsDataURL`：那样 MIME 由后端 content-type 决定，
 * 而本地接口对 .css / .js 回的是 application/octet-stream，
 * 浏览器会忽略 `data:application/octet-stream` 的样式表（内联了却不生效）。
 */
async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

/** 拼一句 HTML 预览说明：沙盒限制 + 内联情况。 */
function buildHtmlNote(original: string, result: InlineResult): string | null {
  return htmlPreviewNote(original, { skipped: result.skipped, inlined: result.inlined })
}

/** Markdown 用 react-markdown 渲染、HTML 用 iframe 渲染，两者共用同一份「读全文」逻辑。 */
function isTextPreviewPath(path: string): boolean {
  return isMarkdownPath(path) || isHtmlPath(path)
}

/**
 * Markdown/HTML 预览 / 图片 blob / 二进制 hex 三种「整份内容」视图。
 *
 * 它们和分页源码互斥，拆成 hook 后 CodeView 只负责 stat + 页缓存 + 虚拟列表；
 * 每个 effect 都自带 abort 与 alive 标记，切文件/卸载不会把旧结果写回来。
 */
export function useFilePreview(
  root: string,
  path: string | null,
  stat: FileStat | null,
  encoding?: string | null,
): FilePreview {
  const [mode, setModeState] = useState<PreviewMode>('source')
  // 用户手动切过视图（点工具栏、Ctrl+F、跳行）后，自动规则不再抢他的选择
  const manualMode = useRef(false)

  const setMode = useCallback((next: PreviewMode) => {
    manualMode.current = true
    setModeState(next)
  }, [])
  const [preview, setPreview] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [htmlNote, setHtmlNote] = useState<string | null>(null)
  const [hex, setHex] = useState<string | null>(null)
  const [hexError, setHexError] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)

  // 切文件：清掉手动标记并回到源码；等 stat 到了再决定 Markdown 要不要默认预览。
  useEffect(() => {
    manualMode.current = false
    setModeState('source')
  }, [path])

  // Markdown 默认预览，但「1 MB 以上停在源码分页」是硬规格（product.md:28）：
  // stat 未到先保持源码，超过上限也保持源码；用户手动点「预览」才切过去。
  useEffect(() => {
    if (!path || !isTextPreviewPath(path) || manualMode.current) return
    if (!stat) return
    setModeState(stat.binary || stat.size > PREVIEW_MAX_BYTES ? 'source' : 'preview')
  }, [path, stat])

  useEffect(() => {
    if (!path || !stat || stat.binary || mode !== 'preview' || !isTextPreviewPath(path)) return
    if (stat.size > PREVIEW_MAX_BYTES) {
      setPreviewError(
        `文件 ${formatBytes(stat.size)}，超过 1 MB，预览已关闭；点「源码」可按页读全文`,
      )
      return
    }
    let alive = true
    const controller = new AbortController()
    setPreview(null)
    setPreviewError(null)
    setHtmlNote(null)
    const html = isHtmlPath(path)
    readText(root, path, undefined, encoding, controller.signal)
      .then(async (text) => {
        if (!alive) return
        if (!html) {
          setPreview(text)
          return
        }
        // HTML：把相对路径的 css/js/图片读出来内联。
        // 预览走沙盒（拿不到同源，也拿不到父页面 token），不内联的话页面会没样式甚至是白屏。
        const inlined = await inlineLocalResources(
          text,
          path,
          async (rel) => {
            const blob = await readRaw(root, rel, controller.signal)
            return blobToBytes(blob)
          },
        ).catch((err) => {
          if ((err as Error).name === 'AbortError') throw err
          return null
        })
        if (!alive) return
        const result: InlineResult = inlined ?? { html: text, inlined: 0, skipped: [] }
        setPreview(result.html)
        setHtmlNote(buildHtmlNote(text, result))
      })
      .catch((err) => {
        if (!alive) return
        if ((err as Error).name === 'AbortError') return
        setPreviewError((err as Error).message)
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [root, path, stat, mode, encoding])

  useEffect(() => {
    if (!path || !stat || !stat.binary || isImagePath(path)) return
    let alive = true
    const controller = new AbortController()
    setHex(null)
    setHexError(null)
    readHex(root, path, 4096, controller.signal)
      .then((text) => {
        if (alive) setHex(text)
      })
      .catch((err) => {
        if (alive) setHexError((err as Error).message)
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [root, path, stat])

  useEffect(() => {
    if (!path || !stat || !isImagePath(path)) return
    if (stat.size > IMAGE_MAX_BYTES) {
      setImageError(`图片 ${formatBytes(stat.size)}，超过 64 MB，暂不加载`)
      return
    }
    let alive = true
    let url: string | null = null
    const controller = new AbortController()
    setImageUrl(null)
    setImageError(null)
    readRaw(root, path, controller.signal)
      .then((blob) => {
        if (!alive) return
        url = URL.createObjectURL(blob)
        setImageUrl(url)
      })
      .catch((err) => {
        if (alive) setImageError((err as Error).message)
      })
    return () => {
      alive = false
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [root, path, stat])

  return {
    mode,
    setMode,
    preview,
    previewError,
    htmlNote,
    hex,
    hexError,
    imageUrl,
    imageError,
  }
}
