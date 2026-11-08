type Props = {
  path: string | null
  content: string
  loading: boolean
  error?: string | null
}

export default function CodeView({ path, content, loading, error }: Props) {
  if (!path) {
    return (
      <div className="editor-empty">
        <div className="editor-empty-icon">⌘</div>
        <div>选择左侧文件查看</div>
      </div>
    )
  }

  const lines = content.split('\n')

  return (
    <div className="editor">
      <div className="editor-path" title={path}>
        {path}
      </div>
      {error ? (
        <div className="editor-error">{error}</div>
      ) : loading ? (
        <div className="editor-empty">加载中…</div>
      ) : (
        <div className="code-scroll">
          <pre className="code-block">
            {lines.map((line, index) => (
              <div className="code-line" key={index}>
                <span className="line-no">{index + 1}</span>
                <span className="code-text">{line || ' '}</span>
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}
