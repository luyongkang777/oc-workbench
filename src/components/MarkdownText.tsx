import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

/**
 * 把 agent 回复按 Markdown 渲染（GFM：表格、删除线、任务列表；breaks：单换行保留成 <br>）。
 *
 * 用 react-markdown 而不是 marked + innerHTML：它默认**不渲染原始 HTML**，
 * 会话内容里夹带的 `<script>` / `<img onerror>` 都只会显示成文字，不用再挂 sanitizer。
 *
 * 两个安全/行为约定：
 *   1. 链接不直接导航（wry 对 `target=_blank` 的新窗口请求是直接取消的，点了会像卡死），
 *      改发 `oc:open-url:<url>` 给外壳，由系统默认浏览器打开；dev 模式用 window.open。
 *   2. 图片不自动加载，只显示占位文本——避免历史会话里的远程图片静默外联。
 */

// 模块级常量：每次渲染都新建数组/对象会让 react-markdown 反复重建处理器
const PLUGINS = [remarkGfm, remarkBreaks]

/** 只放行 http/https/mailto；react-markdown 已把 javascript: 等清洗成空，这里再兜一层。 */
function safeHref(href?: string): string | null {
  if (!href) return null
  const trimmed = href.trim()
  if (!trimmed) return null
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null
}

function openExternal(url: string) {
  const w = window as unknown as { ipc?: { postMessage(message: string): void } }
  if (w.ipc?.postMessage) {
    w.ipc.postMessage(`oc:open-url:${url}`)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

const COMPONENTS: Components = {
  a: ({ href, children }) => {
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
      >
        {children}
      </a>
    )
  },
  img: ({ src, alt }) => (
    <span className="md-img" title={typeof src === 'string' ? src : undefined}>
      [图片{alt ? `：${alt}` : ''}]
    </span>
  ),
}

function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

// 流式输出期间每 250ms 全量重渲染，text 没变的旧消息要能跳过同步解析
export default memo(MarkdownText)
