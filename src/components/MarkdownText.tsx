import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 把 agent 回复按 Markdown 渲染（GFM 支持表格、删除线、任务列表）。
 *
 * 用 react-markdown 而不是 marked + innerHTML：它默认**不渲染原始 HTML**，
 * 会话内容里夹带的 `<script>` / `<img onerror>` 都只会显示成文字，不用再挂 sanitizer。
 */
export default function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} title={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
