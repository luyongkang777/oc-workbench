import { useEffect, useState } from 'react'
import {
  canFetchModels,
  effectiveContext,
  effectiveOutput,
  PRESETS,
  presetForBaseURL,
  updateModelLimit,
} from '../components/providerForm'
import { PRESET_ICONS } from '../components/providerPresets'
import type { ProviderController } from '../hooks/useProviderPanel'
import type { ProviderSyncController } from '../hooks/useProviderSync'
import MaxiCard from './MaxiCard'
import WorkBuddyCard from './WorkBuddyCard'
import ProviderList from './ProviderList'
import ProviderModelList from './ProviderModelList'
import ProviderQuotaBox from './ProviderQuotaBox'
import ProviderSyncBlock from './ProviderSyncBlock'
import type { ProviderInfo } from '../api/provider'

/** 用系统浏览器打开外链（WebView2 里 window.open 会被壳拦成新窗口）。 */
function openExternal(url: string) {
  const w = window as unknown as { ipc?: { postMessage(message: string): void } }
  if (w.ipc?.postMessage) {
    w.ipc.postMessage(`oc:open-url:${url}`)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

type Props = {
  controller: ProviderController
  /** 账号级同步（登录后把 provider/SK/默认模型存到账号） */
  sync: ProviderSyncController
  open: boolean
  onClose: () => void
}

/**
 * 第三方 API 接入面板（顶栏插头按钮）。
 *
 * 三件事说清就够，不要堆说明文字：
 *   1. 左边是配置里已有的 provider，点一条就编辑它；
 *   2. 右边是表单：地址 + 密钥 + 「获取模型」+ 勾选 + 保存；
 *   3. 保存只写 `opencode.json` 的 provider 段，其它配置一个字不动（会先备份）。
 */
export default function ProviderPanel({ controller, sync, open, onClose }: Props) {
  const {
    status,
    quota,
    usage,
    loading,
    busy,
    quotaBusy,
    message,
    form,
    models,
    saveDisabled,
    edit,
    preset,
    patch,
    fetchModels,
    save,
    remove,
    selectAll,
    reload,
    refreshQuota,
    normalizedBase,
  } = controller

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const providers: ProviderInfo[] = status?.providers ?? []
  // 先取一次再判 kind：直接写 quota[form.id].note 时 TS 收窄不了联合类型
  const currentQuota = form.id ? quota[form.id] : undefined
  const fileError = status?.error ?? ''
  // 删除要两步：这些条目里可能有用户手写的大 provider（几十个模型），
  // 点一下就没了太容易误伤。第一次点变「确认」，第二次才真删。
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  useEffect(() => {
    if (!open) setPendingDelete(null)
  }, [open])

  return (
    <>
      <div
        className={`provider-mask${open ? ' open' : ''}`}
        onClick={onClose}
        aria-hidden={open ? undefined : true}
      />
      <aside className={`provider-panel${open ? ' open' : ''}`} aria-label="第三方 API 接入">
        <header className="provider-head">
          <span className="provider-title">第三方 API 接入</span>
          <button type="button" className="provider-close" onClick={onClose} title="关闭（Esc）">
            ×
          </button>
        </header>

        <div className="provider-body">
          {fileError ? (
            <div className="provider-alert" role="alert">
              {fileError}
              <div className="provider-alert-hint">修好文件之前，保存会被拒绝（不会覆盖你的配置）。</div>
            </div>
          ) : null}

          <ProviderSyncBlock sync={sync} status={status} providers={providers} onReload={() => void controller.reload()} />

          <section className="provider-section">
            <div className="provider-section-head">
              <span>已配置（{providers.length}）</span>
              <span className="provider-actions">
                <button
                  type="button"
                  className="provider-btn"
                  onClick={() => void refreshQuota()}
                  disabled={quotaBusy || loading}
                  title="重新查询所有服务商的额度与本机用量"
                >
                  {quotaBusy ? '刷新中…' : '刷新额度'}
                </button>
                <button type="button" className="provider-btn" onClick={() => edit(null)} disabled={busy}>
                  自定义
                </button>
              </span>
            </div>
            <div className="provider-presets">
              {PRESETS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`provider-preset${form.id === item.id ? ' active' : ''}`}
                  onClick={() => preset(item)}
                  disabled={busy}
                  title={`使用 ${item.name} 预设（地址 ${item.baseURL}）`}
                >
                  <img className="provider-icon" src={PRESET_ICONS[item.icon]} alt="" />
                  <span className="provider-preset-text">
                    <span className="provider-preset-name">{item.name}</span>
                    <span className="provider-preset-url">{new URL(item.baseURL).host}</span>
                  </span>
                </button>
              ))}
              <WorkBuddyCard controller={controller} open={open} />
              <MaxiCard controller={controller} open={open} />
            </div>
            {loading && providers.length === 0 ? (
              <div className="provider-empty">读取中…</div>
            ) : providers.length === 0 ? (
              <div className="provider-empty">还没有配置。点「DeepSeek 官方」或「新增」开始。</div>
            ) : (
              <ProviderList controller={controller} pendingDelete={pendingDelete} onPendingDelete={setPendingDelete} />
            )}
          </section>

          <section className="provider-section">
            <div className="provider-section-head">
              <span>{form.id ? `编辑 ${form.id}` : '新增服务商'}</span>
            </div>
            <label className="provider-field">
              <span>ID</span>
              <input
                className="provider-input"
                value={form.id}
                onChange={(event) => patch('id', event.target.value)}
                placeholder="deepseek"
                spellCheck={false}
              />
            </label>
            <label className="provider-field">
              <span>显示名</span>
              <input
                className="provider-input"
                value={form.name}
                onChange={(event) => patch('name', event.target.value)}
                placeholder="DeepSeek 官方"
              />
            </label>
            <label className="provider-field">
              <span>接口地址</span>
              <input
                className="provider-input"
                value={form.baseURL}
                onChange={(event) => patch('baseURL', event.target.value)}
                placeholder="https://api.deepseek.com/v1"
                spellCheck={false}
              />
            </label>
            {normalizedBase && normalizedBase !== form.baseURL.trim() ? (
              <div className="provider-hint">会保存成：{normalizedBase}</div>
            ) : null}
            <label className="provider-field">
              <span>API Key</span>
              <input
                className="provider-input"
                value={form.apiKey}
                onChange={(event) => patch('apiKey', event.target.value)}
                placeholder="sk-..."
                spellCheck={false}
                autoComplete="off"
              />
            </label>

            <div className="provider-actions">
              <button
                type="button"
                className="provider-btn"
                onClick={() => void fetchModels()}
                disabled={busy || !canFetchModels(form)}
              >
                {busy ? '处理中…' : '获取模型'}
              </button>
              <button
                type="button"
                className="provider-btn primary"
                onClick={() => void save()}
                disabled={saveDisabled}
              >
                保存
              </button>
            </div>

            <ProviderModelList controller={controller} />

            <ProviderQuotaBox
              quota={currentQuota}
              usage={form.id ? usage[form.id] : undefined}
              onOpenConsole={openExternal}
            />

            {message ? <div className="provider-message">{message}</div> : null}

            <div className="provider-foot">
              写入：{status?.path ?? '（未知路径）'}
              <br />
              保存前会自动备份成 <code>opencode.json.bak-&lt;时间戳&gt;</code>，只改 provider 一段。
            </div>
          </section>
        </div>
      </aside>
    </>
  )
}
