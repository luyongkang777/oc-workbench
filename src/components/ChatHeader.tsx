import { useEffect, useRef, useState } from 'react'
import type { ModelInfo, SessionInfo } from '../api/chat'

type ModelKey = { id: string; providerID: string }

type Props = {
  sessions: SessionInfo[]
  current: SessionInfo | undefined
  expanded: boolean
  models: ModelInfo[]
  modelsLoading?: boolean
  modelsError?: string | null
  onRetryModels?: () => void
  currentModel: ModelKey | null
  connected: boolean
  onToggleSessions: () => void
  onPickSession: (id: string) => void
  onNewSession: () => void
  onPickModel: (model: ModelInfo) => void
}

export function shortTitle(session: SessionInfo): string {
  const title = session.title?.trim()
  if (title) return title
  return session.id.replace(/^ses_/, '').slice(0, 10)
}

function formatTime(ms?: number): string {
  if (!ms) return ''
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export default function ChatHeader({
  sessions,
  current,
  expanded,
  models,
  modelsLoading,
  modelsError,
  onRetryModels,
  currentModel,
  connected,
  onToggleSessions,
  onPickSession,
  onNewSession,
  onPickModel,
}: Props) {
  const [modelsOpen, setModelsOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const modelsBox = useRef<HTMLDivElement | null>(null)

  // 点外面收起模型下拉
  useEffect(() => {
    if (!modelsOpen) return
    const onDown = (event: MouseEvent) => {
      if (modelsBox.current && !modelsBox.current.contains(event.target as Node)) {
        setModelsOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [modelsOpen])

  const active = currentModel
    ? models.find((m) => m.id === currentModel.id && m.providerID === currentModel.providerID)
    : undefined
  // 用完整 name：很多模型的区别只在「 · 后缀」（例如「破甲 · DeepSeek 官方」），
  // 截断会把它们全变成同一个词。放不下交给 CSS 省略 + title 提示。
  const modelLabel = active?.name ?? active?.id ?? currentModel?.id ?? '选择模型'

  const keyword = filter.trim().toLowerCase()
  const visible = keyword
    ? models.filter((m) =>
        `${m.name ?? ''} ${m.id} ${m.providerID}`.toLowerCase().includes(keyword),
      )
    : models

  return (
    <>
      <div className="chat-header">
        <button
          type="button"
          className="chat-session-toggle"
          onClick={onToggleSessions}
          title="切换会话"
        >
          {current ? shortTitle(current) : '会话'} ▾
        </button>

        <div className="model-picker" ref={modelsBox}>
          <button
            type="button"
            className="model-toggle"
            title={active?.name ?? modelLabel}
            onClick={() => setModelsOpen((v) => !v)}
          >
            <span className="model-toggle-text">{modelLabel}</span>
            <span className="model-toggle-caret">▾</span>
          </button>
          {modelsOpen ? (
            <div className="model-menu">
              <input
                className="model-filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="筛选模型"
                autoFocus
              />
              <div className="model-list">
                {modelsError ? (
                  <button type="button" className="model-retry" onClick={() => onRetryModels?.()}>
                    模型列表加载失败，点击重试
                  </button>
                ) : modelsLoading && models.length === 0 ? (
                  <div className="model-empty">加载模型列表…</div>
                ) : visible.length === 0 ? (
                  <div className="model-empty">{models.length === 0 ? '没有可用模型' : '没有匹配的模型'}</div>
                ) : (
                  visible.map((model) => {
                    const isActive =
                      currentModel?.id === model.id &&
                      currentModel.providerID === model.providerID
                    return (
                      <button
                        key={`${model.providerID}/${model.id}`}
                        type="button"
                        className={`model-item${isActive ? ' active' : ''}`}
                        title={`${model.name ?? model.id}（${model.providerID}）`}
                        onClick={() => {
                          onPickModel(model)
                          setModelsOpen(false)
                          setFilter('')
                        }}
                      >
                        <span className="model-name">{model.name ?? model.id}</span>
                        <span className="model-provider">{model.providerID}</span>
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          ) : null}
        </div>

        <button type="button" className="chat-new" onClick={onNewSession} disabled={!connected}>
          + 新会话
        </button>
      </div>

      {expanded ? (
        <div className="chat-sessions">
          {sessions.length === 0 ? (
            <div className="chat-session-empty">还没有会话</div>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className={`chat-session-item${session.id === current?.id ? ' active' : ''}`}
                onClick={() => onPickSession(session.id)}
              >
                <span>{shortTitle(session)}</span>
                <span className="chat-session-time">
                  {formatTime(session.time?.updated ?? session.time?.created)}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </>
  )
}
