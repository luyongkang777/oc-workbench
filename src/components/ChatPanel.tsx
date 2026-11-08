type Props = {
  connected: boolean
}

export default function ChatPanel({ connected }: Props) {
  return (
    <div className="chat">
      <div className="chat-header">
        <span>会话</span>
        <span className="chat-badge">下一阶段接入</span>
      </div>

      {!connected ? <div className="chat-warn">后端未连接</div> : null}

      <div className="chat-body">
        <div className="chat-placeholder">
          会话面板下一阶段接入：
          <br />
          新建会话、发消息、流式回复、diff 审查
        </div>
      </div>

      <div className="chat-input-wrap">
        <textarea className="chat-input" disabled placeholder="会话功能下一阶段接入" />
        <button className="chat-send" disabled>
          发送
        </button>
      </div>
    </div>
  )
}
