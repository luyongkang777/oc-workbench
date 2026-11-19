/**
 * 多模型路由面板：给「主脑 / 执行体 / 审核体」各选一个模型，
 * 生成项目级 `.opencode/agents/router-*.md`。
 *
 * 不负责实际编排：编排在 opencode 的 agent/subagent 里，
 * 这里只做配置和状态回显。
 */

import { useEffect, useState } from 'react'

import type { ModelInfo } from '../api/chat'
import { useRouterConfig } from '../hooks/useRouterConfig'
import {
  ROLE_LABELS,
  ROUTER_AGENT_NAMES,
  ROUTER_ROLES,
  type RouterModel,
  type RouterModels,
  type RouterRole,
} from './routerConfig'

type Props = {
  root: string
  models: ModelInfo[]
  onClose: () => void
  /** 保存/删除成功后通知外层刷新 agent 列表 */
  onApplied: () => void
}

const EMPTY: RouterModel = { providerID: '', id: '' }

function modelIndex(models: ModelInfo[], model: RouterModel | undefined): string {
  if (!model?.providerID || !model.id) return ''
  const index = models.findIndex(
    (item) => item.providerID === model.providerID && item.id === model.id,
  )
  return index >= 0 ? String(index) : ''
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function RouterPanel({ root, models, onClose, onApplied }: Props) {
  const api = useRouterConfig(root)
  const [draft, setDraft] = useState<RouterModels>({
    main: EMPTY,
    worker: EMPTY,
    reviewer: EMPTY,
  })
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  // 读盘结果回来后回填；保存后也会走这里（值不变）
  useEffect(() => {
    setDraft({
      main: api.models.main ?? EMPTY,
      worker: api.models.worker ?? EMPTY,
      reviewer: api.models.reviewer ?? EMPTY,
    })
  }, [api.models.main, api.models.worker, api.models.reviewer])

  function pickModel(role: RouterRole, raw: string) {
    // 空 value 是「选择模型…」占位项，Number('') 会变成 0 误选第一个模型
    if (!raw) return
    const model = models[Number(raw)]
    if (!model) return
    setDraft((prev) => ({
      ...prev,
      [role]: { providerID: model.providerID, id: model.id },
    }))
  }

  function pickVariant(role: RouterRole, variant: string) {
    setDraft((prev) => {
      const current = prev[role]
      const next: RouterModel = variant
        ? { providerID: current.providerID, id: current.id, variant }
        : { providerID: current.providerID, id: current.id }
      return { ...prev, [role]: next }
    })
  }

  async function save() {
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      await api.save(draft)
      setNote('已生成配置。到上方「模式」里选 router-main 后生效。')
      onApplied()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      await api.remove()
      setConfirmRemove(false)
      setNote('已删除配置，模式下拉里不再出现 router-*。')
      onApplied()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="router-backdrop" onMouseDown={onClose}>
      <div
        className="router-panel"
        role="dialog"
        aria-label="多模型路由"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="router-head">
          <div>
            <div className="router-title">多模型路由</div>
            <div className="router-sub">
              {api.status.ready ? '已启用' : '未启用'} · 主脑只思考，执行体跑工具，审核体判定
            </div>
          </div>
          <button type="button" className="router-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        {api.error ? <div className="router-error">{api.error}</div> : null}

        <div className="router-rows">
          {ROUTER_ROLES.map((role) => {
            const selected = draft[role]
            const index = modelIndex(models, selected)
            const model = index ? models[Number(index)] : undefined
            const variants = model?.variants ?? []
            return (
              <div className="router-row" key={role}>
                <span className="router-role" title={ROUTER_AGENT_NAMES[role]}>
                  {ROLE_LABELS[role]}
                </span>
                <select
                  className="router-select router-model"
                  value={index}
                  disabled={busy || models.length === 0}
                  onChange={(event) => pickModel(role, event.target.value)}
                >
                  <option value="">
                    {models.length === 0 ? '模型列表未加载' : '选择模型…'}
                  </option>
                  {models.map((item, i) => (
                    <option key={`${item.providerID}/${item.id}/${i}`} value={String(i)}>
                      {item.name ?? item.id} · {item.providerID}
                    </option>
                  ))}
                </select>
                <select
                  className="router-select router-variant"
                  value={selected.variant ?? ''}
                  disabled={busy || variants.length === 0}
                  title={variants.length === 0 ? '该模型没有可选档位' : '思考强度'}
                  onChange={(event) => pickVariant(role, event.target.value)}
                >
                  <option value="">默认</option>
                  {variants.map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {variant.name ?? variant.id}
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>

        <div className="router-hint">
          主脑没有改文件和跑命令的权限，只能派子任务；执行体与审核体不能是同一个模型。
        </div>

        {note ? <div className="router-note">{note}</div> : null}
        {error ? <div className="router-error">{error}</div> : null}

        <div className="router-actions">
          <button type="button" className="router-primary" disabled={busy} onClick={() => void save()}>
            {busy ? '处理中…' : api.status.ready ? '更新配置' : '生成配置'}
          </button>
          {api.status.ready ? (
            confirmRemove ? (
              <>
                <button
                  type="button"
                  className="router-danger"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  确认删除
                </button>
                <button
                  type="button"
                  className="router-plain"
                  disabled={busy}
                  onClick={() => setConfirmRemove(false)}
                >
                  取消
                </button>
              </>
            ) : (
              <button
                type="button"
                className="router-danger"
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
              >
                删除配置
              </button>
            )
          ) : null}
          <button type="button" className="router-plain" disabled={busy} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

/** 聊天头部的小按钮；弹层按需挂载，不占常驻 DOM。 */
export function RouterToggle({
  root,
  models,
  onApplied,
}: {
  root: string
  models: ModelInfo[]
  onApplied: () => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        className="router-toggle"
        title="多模型路由：主脑 / 执行体 / 审核体"
        onClick={() => setOpen(true)}
      >
        路由
      </button>
      {open ? (
        <RouterPanel
          root={root}
          models={models}
          onClose={() => setOpen(false)}
          onApplied={onApplied}
        />
      ) : null}
    </>
  )
}
