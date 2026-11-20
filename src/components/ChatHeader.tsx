import { useEffect, useRef, useState } from 'react'
import {
  sessionLastAt,
  type AgentInfo,
  type ModelInfo,
  type SessionInfo,
} from '../api/chat'
import type { ContextUsage } from './contextUsage'
import ContextMeter from './ContextMeter'
import PurgeToggle from './PurgeToggle'
import { RouterToggle } from './RouterPanel'
import type { PurgeController } from '../hooks/usePurge'
import { lightFromSnapshot, sessionLight, type SessionLike } from './sessionLight'
import SessionMenu, { shortTitle } from './SessionMenu'
import { filterByKeyword, selectableModels } from './modelList'
export { shortTitle } from './SessionMenu'

type ModelKey = { id: string; providerID: string; variant?: string }

type Props = {
  sessions: SessionInfo[]
  /** 会话 id → 最新 busy/idle 快照，用来点亮每一条的状态灯 */
  lights?: Map<string, SessionLike>
  current: SessionInfo | undefined
  expanded: boolean
  models: ModelInfo[]
  modelsLoading?: boolean
  modelsError?: string | null
  onRetryModels?: () => void
  /** 静默重新拉取模型列表（不显示 loading，打开下拉时调用） */
  onRefreshModels?: () => void
  currentModel: ModelKey | null
  /** 可切换的模式（服务端 agent，已滤掉 hidden 与 subagent） */
  agents: AgentInfo[]
  /** 当前模式 id；空串表示跟随服务端默认 */
  currentAgent: string
  onPickAgent: (id: string) => void
  connected: boolean
  onToggleSessions: () => void
  onPickSession: (id: string) => void
  onNewSession: () => void
  /** 在新面板里打开这条会话（分屏），不传就不显示按钮 */
  onOpenInPanel?: (id: string) => void
  /** 已经开在别的面板里的会话 id：列表里标一下，免得重复开 */
  panelIDs?: Set<string>
  onPickModel: (model: ModelInfo) => void
  /** 选模型 + 思考强度；variant 为空 = 该模型默认档位 */
  onPickVariant: (model: ModelInfo, variant: string | undefined) => void
  /** 被「只显示工作台会话」过滤掉的外部会话数量 */
  hiddenCount: number
  showAll: boolean
  onToggleShowAll: () => void
  /** 上下文用量面板；不传就不显示（终端等场景用不到） */
  context?: {
    usage: ContextUsage
    compacting: boolean
    onCompact: () => void
  }
  /** 破甲注入开关；不传就不显示（终端等场景用不到） */
  purge?: PurgeController
  /** 当前项目根；有值才显示「路由」按钮 */
  root?: string
  /** 路由配置变更后通知外层刷新 agent 列表 */
  onRouterApplied?: () => void
  /** 窄列模式（分屏列）：文字按钮收成图标，把宽度让给会话标题和模型名 */
  compact?: boolean
}

/** 会话灯：走共用判定，快照里没有这条就是灰（未验证）。 */
function lightFor(
  session: SessionInfo,
  lights: Map<string, SessionLike> | undefined,
  connected: boolean,
) {
  return lightFromSnapshot(session.id, lights, connected)
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
  lights,
  current,
  expanded,
  models,
  modelsLoading,
  modelsError,
  onRetryModels,
  onRefreshModels,
  currentModel,
  connected,
  agents,
  currentAgent,
  onPickAgent,
  onToggleSessions,
  onPickSession,
  onNewSession,
  onOpenInPanel,
  panelIDs,
  onPickModel,
  onPickVariant,
  hiddenCount,
  showAll,
  onToggleShowAll,
  context,
  purge,
  compact,
  root,
  onRouterApplied,
}: Props) {
  const [modelsOpen, setModelsOpen] = useState(false)
  const [modesOpen, setModesOpen] = useState(false)
  const modesBox = useRef<HTMLDivElement | null>(null)
  const [filter, setFilter] = useState('')
  /** 思考强度是独立下拉：和模型列表分开，选模型不会再被拽进档位面板 */
  const [variantsOpen, setVariantsOpen] = useState(false)
  const modelsBox = useRef<HTMLDivElement | null>(null)
  const variantsBox = useRef<HTMLDivElement | null>(null)

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

  // 点外面收起模式下拉
  useEffect(() => {
    if (!modesOpen) return
    const onDown = (event: MouseEvent) => {
      if (modesBox.current && !modesBox.current.contains(event.target as Node)) {
        setModesOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [modesOpen])

  // 点外面收起思考强度下拉
  useEffect(() => {
    if (!variantsOpen) return
    const onDown = (event: MouseEvent) => {
      if (variantsBox.current && !variantsBox.current.contains(event.target as Node)) {
        setVariantsOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [variantsOpen])

  const activeAgent = agents.find((a) => a.id === currentAgent)
  // 没有 name 的 agent（自定义配置常见）用 id 兜底
  const agentLabel = activeAgent?.name ?? activeAgent?.id ?? currentAgent ?? '模式'

  const active = currentModel
    ? models.find((m) => m.id === currentModel.id && m.providerID === currentModel.providerID)
    : undefined
  // 用完整 name：很多模型的区别只在「 · 后缀」（例如「破甲 · DeepSeek 官方」），
  // 截断会把它们全变成同一个词。放不下交给 CSS 省略 + title 提示。
  const modelLabel = active?.name ?? active?.id ?? currentModel?.id ?? '选择模型'

  // 内置 provider 自带的模型不显示（判定与例外都在 modelList.ts，有单测）：
  // 它们和用户自己接入的那批是同一份模型，一个模型在下拉里出现两次只会让人选错。
  // 当前正在用的那条例外保留，否则切走之后就再也点不回来。
  const selectable = selectableModels(models, currentModel)
  const visible = filterByKeyword(selectable, filter)

  // opencode 在「不带 variant」切换后会把 variant 记成 "default"，显示时当作没选档位
  const variantId = currentModel?.variant && currentModel.variant !== 'default' ? currentModel.variant : ''
  // 只有当前模型自己声明了档位，独立下拉才有内容可选
  const variantList = active?.variants ?? []

  function closeMenu() {
    setModelsOpen(false)
    setFilter('')
  }

  const currentLight = current
    ? lightFor(current, lights, connected)
    : 'unknown'

  // 比当前会话更新的会话数：手机端 / CLI 里新建的会话会立刻落在这个计数里，
  // 不用展开下拉才知道「那边有动静」。切到更新的会话后计数自然归零。
  const currentAt = current ? sessionLastAt(current) ?? 0 : 0
  const newerCount =
    currentAt > 0
      ? sessions.filter((item) => item.id !== current?.id && (sessionLastAt(item) ?? 0) > currentAt).length
      : 0

  return (
    <>
      <div className="chat-header">
        <button
          type="button"
          className="chat-session-toggle"
          onClick={onToggleSessions}
          title="切换会话"
        >
          <span className={`chat-session-light ${currentLight}`} aria-hidden="true" />
          <span className="chat-session-toggle-text">
            {current ? shortTitle(current) : '会话'} ▾
          </span>
          {newerCount > 0 ? (
            <span className="chat-session-badge" title={`有 ${newerCount} 个比当前更新的会话`}>
              {newerCount}
            </span>
          ) : null}
        </button>

        <div className="mode-picker" ref={modesBox}>
          <button
            type="button"
            className={`mode-toggle${modesOpen ? ' open' : ''}`}
            title={`模式：${agentLabel}${activeAgent?.description ? `\n${activeAgent.description}` : ''}`}
            onClick={() => setModesOpen((value) => !value)}
            disabled={agents.length === 0}
          >
            <span className="mode-toggle-text">{agentLabel}</span>
            <span className="mode-toggle-caret">▾</span>
          </button>
          {modesOpen ? (
            <div className="mode-menu">
              {agents.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`mode-item${item.id === currentAgent ? ' active' : ''}`}
                  title={item.description}
                  onClick={() => {
                    onPickAgent(item.id)
                    setModesOpen(false)
                  }}
                >
                  <span className="mode-item-name">{item.name ?? item.id}</span>
                  {item.description ? (
                    <span className="mode-item-desc">{item.description}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="model-picker" ref={modelsBox}>
          <button
            type="button"
            className="model-toggle"
            title={active?.name ?? modelLabel}
            onClick={() => {
              if (modelsOpen) closeMenu()
              else {
                // 每次打开都静默同步一次：网关刚加的模型点开就能看到，不必等轮询或重连
                onRefreshModels?.()
                setModelsOpen(true)
              }
            }}
          >
            <span className="model-toggle-text">{modelLabel}</span>
            <span className="model-toggle-caret">▾</span>
          </button>
          {modelsOpen ? (
            <div className="model-menu">
                <>
                  <div className="model-filter-row">
                    <input
                      className="model-filter"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                      placeholder="筛选模型"
                      autoFocus
                    />
                    <button
                      type="button"
                      className="model-refresh"
                      title="重新拉取模型列表"
                      onClick={() => onRefreshModels?.()}
                    >
                      刷新
                    </button>
                  </div>
                  <div className="model-list">
                    {modelsError ? (
                      <button type="button" className="model-retry" onClick={() => onRetryModels?.()}>
                        模型列表加载失败，点击重试
                      </button>
                    ) : modelsLoading && models.length === 0 ? (
                      <div className="model-empty">加载模型列表…</div>
                    ) : visible.length === 0 ? (
                      <div className="model-empty">
                        {filter.trim()
                          ? '没有匹配的模型'
                          : models.length === 0
                            ? '没有可用模型'
                            : selectable.length === 0
                              ? '只剩 opencode 内置模型了，去「第三方 API 接入」配一个自己的服务商'
                              : '没有可用模型'}
                      </div>
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
                              // 档位不再塞在模型里：这里只切模型，思考强度用右边独立下拉
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
            </div>
          ) : null}
        </div>

        {/* 思考强度：独立下拉，只作用于当前模型。换模型后列表跟着新模型走。 */}
        <div className="variant-picker" ref={variantsBox}>
          <button
            type="button"
            className={`variant-toggle${variantsOpen ? ' open' : ''}`}
            title={
              active
                ? variantList.length > 0
                  ? `${active.name ?? active.id} 的思考强度`
                  : `${active.name ?? active.id} 没有可选档位`
                : '先选一个模型'
            }
            onClick={() => {
              if (variantList.length === 0) return
              setVariantsOpen((value) => !value)
            }}
            disabled={!active || variantList.length === 0}
          >
            <span className="variant-toggle-text">
              <span className="variant-toggle-prefix">思考：</span>
              {variantId ? variantLabel(variantId) : '默认'}
            </span>
            <span className="model-toggle-caret">▾</span>
          </button>
          {variantsOpen && active ? (
            <div className="variant-menu">
              <button
                type="button"
                className={`variant-item${!variantId ? ' active' : ''}`}
                onClick={() => {
                  onPickVariant(active, undefined)
                  setVariantsOpen(false)
                }}
              >
                <span>默认</span>
                <span className="model-variant-id">default</span>
              </button>
              {variantList.map((variant) => (
                <button
                  key={variant.id}
                  type="button"
                  className={`variant-item${variantId === variant.id ? ' active' : ''}`}
                  title={variant.id}
                  onClick={() => {
                    onPickVariant(active, variant.id)
                    setVariantsOpen(false)
                  }}
                >
                  <span>{variantLabel(variant.id)}</span>
                  <span className="model-variant-id">{variant.id}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {context ? <ContextMeter {...context} /> : null}

        {purge ? <PurgeToggle controller={purge} currentModel={currentModel} /> : null}

        {root ? (
          <RouterToggle root={root} models={models} onApplied={onRouterApplied ?? (() => {})} />
        ) : null}

        <button
          type="button"
          className="chat-new"
          onClick={onNewSession}
          disabled={!connected}
          title="新会话"
          aria-label="新会话"
        >
          <span className="chat-new-plus" aria-hidden="true">＋</span>
          <span className="chat-new-text">新会话</span>
        </button>

      </div>

      {expanded ? (
        <SessionMenu
          sessions={sessions}
          lights={lights}
          current={current}
          connected={connected}
          onPick={onPickSession}
          onOpenInPanel={onOpenInPanel}
          panelIDs={panelIDs}
          hiddenCount={hiddenCount}
          showAll={showAll}
          onToggleShowAll={onToggleShowAll}
          onClose={onToggleSessions}
        />
      ) : null}
    </>
  )
}
