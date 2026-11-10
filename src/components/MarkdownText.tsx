import { Children, Fragment, memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { readRaw } from '../api/localfs'
import { localPathOf } from './localPath'
import { parseFilePath, splitTextPaths, type FileRef } from './fileLinks'

/**
 * 把 agent 回复按 Markdown 渲染（GFM：表格、删除线、任务列表；breaks：单换行保留成 <br>）。
 *
 * 用 react-markdown 而不是 marked + innerHTML：它默认**不渲染原始 HTML**，
 * 会话内容里夹带的 `<script>` / `<img onerror>` 都只会显示成文字，不用再挂 sanitizer。
 *
 * 四个安全/行为约定：
 *   1. 链接不直接导航（wry 对 `target=_blank` 的新窗口请求是直接取消的，点了会像卡死），
 *      改发 `oc:open-url:<url>` 给外壳，由系统默认浏览器打开；dev 模式用 window.open。
 *      左键和中键都拦，避免中键走 auxclick 触发默认导航。
 *   2. 远程图片不自动加载（避免历史会话里的远程图片静默外联），但给一个「点击加载」，
 *      点了才真正请求。
 *   3. 本地图片（模型输出的截图路径、data URL）直接显示：data URL 内联渲染，
 *      工作区内的路径走 `/local/fs/raw` 取 blob（img 标签带不了 x-oc-token）。
 *   4. 文件路径（反引号里的 `src/a.ts`、链接、正文里的裸路径）变成可点按钮，
 *      点了在中间栏打开；带 `:12` / `#L12` 后缀的会直接跳到那一行。
 */

// 模块级常量：每次渲染都新建数组/对象会让 react-markdown 反复重建处理器
const PLUGINS = [remarkGfm, remarkBreaks]

/** 打开工作区文件：line 是 1 基行号（可选）。 */
export type OpenFile = (path: string, line?: number) => void

/**
 * 只放行 http/https/mailto（必须带 //），和外壳 `is_allowed_url` 口径一致；
 * react-markdown 已把 javascript: 等清洗成空，这里再兜一层。
 */
function safeHref(href?: string): string | null {
  if (!href) return null
  const trimmed = href.trim()
  if (!trimmed) return null
  return /^(?:https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null
}

function openExternal(url: string) {
  const w = window as unknown as { ipc?: { postMessage(message: string): void } }
  if (w.ipc?.postMessage) {
    w.ipc.postMessage(`oc:open-url:${url}`)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** 可点的文件路径：外观像链接，行为是「在中间栏打开」。 */
function FileLink({ file, onOpen, children }: { file: FileRef; onOpen: OpenFile; children?: ReactNode }) {
  const label = children ?? file.raw
  return (
    <button
      type="button"
      className="md-file"
      title={`在编辑器打开 ${file.path}${file.line ? ` 第 ${file.line} 行` : ''}`}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onOpen(file.path, file.line)
      }}
    >
      {label}
    </button>
  )
}

/** 一段纯文本里的裸路径：切成「文字 + 可点路径」按原顺序渲染。 */
function Linkified({ text, onOpen }: { text: string; onOpen: OpenFile }) {
  const chunks = useMemo(() => splitTextPaths(text), [text])
  if (chunks.length === 0) return null
  if (chunks.length === 1 && chunks[0].kind === 'text') return <>{text}</>
  return (
    <>
      {chunks.map((chunk, index) =>
        chunk.kind === 'file' ? (
          <FileLink key={`f${index}`} file={chunk.ref} onOpen={onOpen} />
        ) : (
          <Fragment key={`t${index}`}>{chunk.text}</Fragment>
        ),
      )}
    </>
  )
}

/** 只看字符串子节点：嵌套的 strong/em 里的路径不拆（拆了容易破坏嵌套结构）。 */
function withLinks(children: ReactNode, onOpen: OpenFile): ReactNode {
  return Children.map(children, (child) =>
    typeof child === 'string' ? <Linkified text={child} onOpen={onOpen} /> : child,
  )
}

/** 本地图片的 blob 缓存：同一条历史消息刷新时会重复渲染，别每次重读磁盘。 */
const localImageCache = new Map<string, string>()

function LocalImage({ root, path, alt }: { root: string; path: string; alt?: string }) {
  const key = `${root}|${path}`
  const [url, setUrl] = useState<string | null>(() => localImageCache.get(key) ?? null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    const hit = localImageCache.get(key)
    if (hit) {
      setUrl(hit)
      setFailed(null)
      return
    }
    let alive = true
    const controller = new AbortController()
    setUrl(null)
    setFailed(null)
    readRaw(root, path, controller.signal)
      .then((blob) => {
        if (!alive) return
        const objectUrl = URL.createObjectURL(blob)
        localImageCache.set(key, objectUrl)
        setUrl(objectUrl)
      })
      .catch((err) => {
        if (alive) setFailed((err as Error).message)
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [key, root, path])

  if (failed) {
    return (
      <span className="md-img" title={`${path}\n${failed}`}>
        [图片打不开：{path}]
      </span>
    )
  }
  if (!url) return <span className="md-img">[图片加载中：{path}]</span>
  return (
    <img
      className="md-image"
      src={url}
      alt={alt ?? path.split(/[\\/]/).pop() ?? ''}
      title={path}
      loading="lazy"
      onClick={(event) => event.stopPropagation()}
    />
  )
}

/** 远程图片：默认只给一个按钮，点了才请求（避免静默外联）。 */
function RemoteImage({ src, alt }: { src: string; alt?: string }) {
  const [loaded, setLoaded] = useState(false)
  if (!loaded) {
    return (
      <button type="button" className="md-img" title={src} onClick={() => setLoaded(true)}>
        [点击加载图片{alt ? `：${alt}` : ''}]
      </button>
    )
  }
  return <img className="md-image" src={src} alt={alt ?? ''} title={src} loading="lazy" />
}

function ImageBlock({ root, src, alt }: { root?: string; src?: string; alt?: string }) {
  if (!src) return <span className="md-img">[图片]</span>
  if (/^(?:data:image\/|blob:)/i.test(src)) {
    return <img className="md-image" src={src} alt={alt ?? ''} loading="lazy" />
  }
  if (/^https?:\/\//i.test(src)) return <RemoteImage src={src} alt={alt} />
  if (!root) return <span className="md-img" title={src}>[图片：{alt || src}]</span>
  const rel = localPathOf(root, src)
  if (rel === null) {
    return (
      <span className="md-img" title={src}>
        [图片不在工作区：{alt || src}]
      </span>
    )
  }
  if (rel === '') return <span className="md-img" title={src}>[图片路径不完整]</span>
  return <LocalImage root={root} path={rel} alt={alt} />
}

function MarkdownText({
  text,
  root,
  onOpenFile,
}: {
  text: string
  root?: string
  /** 不传时文件路径退化成普通文本（例如编辑器里的 Markdown 预览没接这个能力） */
  onOpenFile?: OpenFile
}) {
  const components = useMemo<Components>(() => {
    const linkify = (children: ReactNode) => (onOpenFile ? withLinks(children, onOpenFile) : children)

    return {
      a: ({ href, children }) => {
        // 本地路径优先当「打开文件」；真正的外部链接才交给系统浏览器
        const local = onOpenFile ? parseFilePath(href) : null
        if (local && onOpenFile) {
          return (
            <FileLink file={local} onOpen={onOpenFile}>
              {children}
            </FileLink>
          )
        }
        const safe = safeHref(href)
        // 被清洗成空/不安全的地址：只显示文字，不留一个点了没反应的下划线
        if (!safe) return <>{children}</>
        return (
          <a
            href={safe}
            title={safe}
            onClick={(event) => {
              event.preventDefault()
              openExternal(safe)
            }}
            onAuxClick={(event) => {
              // auxclick 对中键（1）和右键（2）都会触发；只拦中键（不走 click，否则是死链），
              // 右键必须放行，否则想复制链接时会意外拉起浏览器。
              if (event.button !== 1) return
              event.preventDefault()
              openExternal(safe)
            }}
          >
            {children}
          </a>
        )
      },
      code: ({ className, children }) => {
        const raw = Array.isArray(children) ? children.join('') : String(children ?? '')
        // 代码块（有 language- 或含换行）不拆路径：里面全是代码，点了也不该跳
        const block = /language-/.test(className ?? '') || raw.includes('\n')
        const local = !block && onOpenFile ? parseFilePath(raw) : null
        if (local && onOpenFile) return <FileLink file={local} onOpen={onOpenFile} />
        return <code className={className}>{children}</code>
      },
      p: ({ children }) => <p>{linkify(children)}</p>,
      li: ({ children }) => <li>{linkify(children)}</li>,
      td: ({ children }) => <td>{linkify(children)}</td>,
      th: ({ children }) => <th>{linkify(children)}</th>,
      img: ({ src, alt }) => (
        <ImageBlock root={root} src={typeof src === 'string' ? src : undefined} alt={alt} />
      ),
    }
  }, [root, onOpenFile])

  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

// 流式输出期间每 250ms 全量重渲染，text 没变的旧消息要能跳过同步解析
export default memo(MarkdownText)
