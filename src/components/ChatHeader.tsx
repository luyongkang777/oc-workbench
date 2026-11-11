import { useEffect, useRef, useState } from 'react'
import type { ModelInfo, SessionInfo } from '../api/chat'

type ModelKey = { id: string; providerID: string; variant?: string }

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
  /** 选模型 + 思考强度；variant 为空 = 该模型默认档位 */
  onPickVariant: (model: ModelInfo, variant: string | undefined) => void
  /** 被「只显示工作台会话」过滤掉的外部会话数量 */
  hiddenCount: number
  showAll: boolean
  onToggleShowAll: () => void
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

/** 思考强度档位的中文名；模型自定义档位（如 high-fast）直接回退到 id。 */
const VARIANT_LABELS: Record<string, string> = {
  none: '不思考',
  minimal: '极少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最大',
  ultra: '极致',
}

export function variantLabel(id: string): string {
  const fast = id.endsWith('-fast')
  const base = fast ? id.slice(0, -5) : id
  const label = VARIANT_LABELS[base] ?? base
  return fast ? `${label}（快）` : label
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
  onPickVariant,
  hiddenCount,
  showAll,
  onToggleShowAll,
}: Props) {
  const [modelsOpen, setModelsOpen] = useState(false)
  const [filter, setFilter] = useState('')
  /** 点开一个有思考档位的模型后，先选档位再切换 */
  const [pendingModel, setPendingModel] = useState<ModelInfo | null>(null)
  const modelsBox = useRef<HTMLDivElement | null>(null)

  // 点外面收起模型下拉
  useEffect(() => {
    if (!modelsOpen) return
    const onDown = (event: MouseEvent) => {
      if (modelsBox.current && !modelsBox.current.contains(event.target as Node)) {
        setModelsOpen(false)
        setPendingModel(null)
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

  // opencode 在「不带 variant」切换后会把 variant 记成 "default"，显示时当作没选档位
  const variantId = currentModel?.variant && currentModel.variant !== 'default' ? currentModel.variant : ''
  const variantText = variantId ? ` · ${variantId}` : ''

  function closeMenu() {
    setModelsOpen(false)
    setPendingModel(null)
    setFilter('')
  }

  function chooseVariant(variant?: string) {
    if (!pendingModel) return
    onPickVariant(pendingModel, variant)
    closeMenu()
  }

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
            title={`${active?.name ?? modelLabel}${variantText}`}
            onClick={() => {
              if (modelsOpen) closeMenu()
              else setModelsOpen(true)
            }}
          >
            <span className="model-toggle-text">
              {modelLabel}
              {variantText ? <span className="model-toggle-variant">{variantText}</span> : null}
            </span>
            <span className="model-toggle-caret">▾</span>
          </button>
          {modelsOpen ? (
            <div className="model-menu">
              {pendingModel ? (
                <div className="model-variants">
                  <button type="button" className="model-back" onClick={() => setPendingModel(null)}>
                    ← {pendingModel.name ?? pendingModel.id}
                  </button>
                  <div className="model-variant-title">思考强度</div>
                  <div className="model-variant-list">
                    <button
                      type="button"
                      className={`model-variant-item${
                        currentModel?.id === pendingModel.id &&
                        currentModel.providerID === pendingModel.providerID &&
                        (!currentModel.variant || currentModel.variant === 'default')
                          ? ' active'
                          : ''
                      }`}
                      onClick={() => chooseVariant(undefined)}
                    >
                      <span>默认</span>
                      <span className="model-variant-id">default</span>
                    </button>
                    {(pendingModel.variants ?? []).map((variant) => {
                      const isActive =
                        currentModel?.id === pendingModel.id &&
                        currentModel.providerID === pendingModel.providerID &&
                        currentModel.variant === variant.id
                      return (
                        <button
                          key={variant.id}
                          type="button"
                          className={`model-variant-item${isActive ? ' active' : ''}`}
                          title={variant.id}
                          onClick={() => chooseVariant(variant.id)}
                        >
                          <span>{variantLabel(variant.id)}</span>
                          <span className="model-variant-id">{variant.id}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <>
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
                        const hasVariants = (model.variants?.length ?? 0) > 0
                        return (
                          <button
                            key={`${model.providerID}/${model.id}`}
                            type="button"
                            className={`model-item${isActive ? ' active' : ''}`}
                            title={`${model.name ?? model.id}（${model.providerID}）${
                              hasVariants ? ' · 可选思考强度' : ''
                            }`}
                            onClick={() => {
                              // 有档位的模型先进档位面板，选完档位再切换
                              if (hasVariants) {
                                setPendingModel(model)
                                setFilter('')
                                return
                              }
                              onPickModel(model)
                              closeMenu()
                            }}
                          >
                            <span className="model-name">{model.name ?? model.id}</span>
                            {hasVariants ? <span className="model-variant-mark">档位</span> : null}
                            <span className="model-provider">{model.providerID}</span>
                          </button>
                        )
                      })
                    )}
                  </div>
                </>
              )}
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
          {hiddenCount > 0 || showAll ? (
            <button type="button" className="chat-session-more" onClick={onToggleShowAll}>
              {showAll ? '只显示工作台会话' : `显示全部会话（另有 ${hiddenCount} 条外部会话）`}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
