type Props = {
  draft: string
  busy: boolean
  running: boolean
  connected: boolean
  onDraftChange: (value: string) => void
  onSend: () => void
  onStop: () => void
}

/** 输入区：生成中把「发送」换成「停止」。 */
export default function ChatInput({
  draft,
  busy,
  running,
  connected,
  onDraftChange,
  onSend,
  onStop,
}: Props) {
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSend()
    }
  }

  return (
    <div className="chat-input-wrap">
      <textarea
        className="chat-input"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={connected ? '输入消息，Enter 发送，Shift+Enter 换行' : '后端未连接'}
        disabled={!connected}
      />
      {running ? (
        <button type="button" className="chat-send stop" onClick={onStop} title="停止生成">
          停止
        </button>
      ) : (
        <button
          type="button"
          className="chat-send"
          onClick={onSend}
          disabled={!connected || busy || draft.trim().length === 0}
        >
          {busy ? '发送中' : '发送'}
        </button>
      )}
    </div>
  )
}
