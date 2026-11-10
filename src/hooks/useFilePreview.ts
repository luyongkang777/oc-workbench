import { useCallback, useEffect, useRef, useState } from 'react'
import { readHex, readRaw, readText, type FileStat } from '../api/localfs'
import { formatBytes, isImagePath, isMarkdownPath } from '../components/codeWindow'

/** Markdown 全文预览上限：再大 react-markdown 自己就会卡。 */
const PREVIEW_MAX_BYTES = 1024 * 1024
/** 图片预览上限：超过就不加载，避免把内存吃光。 */
const IMAGE_MAX_BYTES = 64 * 1024 * 1024

export type PreviewMode = 'source' | 'preview'

export type FilePreview = {
  mode: PreviewMode
  setMode: (mode: PreviewMode) => void
  preview: string | null
  previewError: string | null
  hex: string | null
  hexError: string | null
  imageUrl: string | null
  imageError: string | null
}

/**
 * Markdown 预览 / 图片 blob / 二进制 hex 三种「整份内容」视图。
 *
 * 它们和分页源码互斥，拆成 hook 后 CodeView 只负责 stat + 页缓存 + 虚拟列表；
 * 每个 effect 都自带 abort 与 alive 标记，切文件/卸载不会把旧结果写回来。
 */
export function useFilePreview(
  root: string,
  path: string | null,
  stat: FileStat | null,
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
    if (!path || !isMarkdownPath(path) || manualMode.current) return
    if (!stat) return
    setModeState(stat.binary || stat.size > PREVIEW_MAX_BYTES ? 'source' : 'preview')
  }, [path, stat])

  useEffect(() => {
    if (!path || !stat || stat.binary || mode !== 'preview' || !isMarkdownPath(path)) return
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
    readText(root, path, controller.signal)
      .then((text) => {
        if (alive) setPreview(text)
      })
      .catch((err) => {
        if (alive) setPreviewError((err as Error).message)
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [root, path, stat, mode])

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
    hex,
    hexError,
    imageUrl,
    imageError,
  }
}
