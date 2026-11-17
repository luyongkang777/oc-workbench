import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchProviderModels,
  getProviderStatus,
  removeProvider,
  saveProvider,
  type ProviderStatus,
} from '../api/provider'
import type { ProviderQuota, ProviderUsage } from '../api/providerQuota'
import { normalizeBaseURL } from '../api/providerFormat'
import { PROVIDERS_SAVED_EVENT } from './useProviderSync'
import { useProviderQuota } from './useProviderQuota'
import {
  applyRemoteModels,
  canFetchModels,
  canSave,
  EMPTY_FORM,
  formFromProvider,
  presetForm,
  saveBlockReason,
  setPickedAll,
  toSaveModels,
  updateModelLimit,
  togglePicked,
  visibleModels,
  type FormState,
  type ProviderPreset,
} from '../components/providerForm'
import type { ProviderInfo } from '../api/provider'

/**
 * 第三方 API 接入面板的全部状态与动作。
 *
 * 面板只负责画：所有「读、拉模型、保存、删除」都在这儿，失败原因统一落在 `message`。
 * 保存成功后必须**回读一次磁盘真值**——界面显示的是配置文件里的实际内容，
 * 不是「我刚提交的请求」。
 *
 * 额度与本机用量单独放在 `useProviderQuota`（网络请求 + 手动刷新自成一块）。
 */
export type ProviderController = {
  status: ProviderStatus | null
  /** providerID → 额度（DeepSeek 有金额，其它只有控制台地址） */
  quota: Record<string, ProviderQuota>
  /** providerID → 本机累计消耗 */
  usage: Record<string, ProviderUsage>
  loading: boolean
  busy: boolean
  /** 正在重新拉额度（与保存/删除的 busy 分开，互不阻塞） */
  quotaBusy: boolean
  message: string | null
  form: FormState
  models: string[]
  saveDisabled: boolean
  /** 编辑已有的一条；传 null 表示新建 */
  edit: (info: ProviderInfo | null) => void
  preset: (preset: ProviderPreset) => void
  /** 一键接入：套预设 → 拉模型 → 优先勾选指定前缀（Magpie 用 `workbuddy/`） */
  connectPreset: (preset: ProviderPreset, preferPrefix?: string) => Promise<void>
  patch: (field: keyof FormState, value: string) => void
  fetchModels: () => Promise<void>
  save: () => Promise<void>
  remove: (id: string) => Promise<void>
  reload: () => Promise<ProviderStatus | null>
  /** 手动刷新所有服务商的额度 + 本机用量 */
  refreshQuota: () => Promise<void>
  toggle: (modelId: string) => void
  /** 全选 / 全不选（模型多的服务商一键处理） */
  selectAll: (checked: boolean) => void
  /** 改某个模型的上下文 / 输出上限 */
  limit: (modelId: string, field: 'context' | 'output', raw: string) => void
  normalizedBase: string
}

export function useProviderPanel(open: boolean, root = ''): ProviderController {
  const [status, setStatus] = useState<ProviderStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const alive = useRef(true)

  const {
    quota,
    usage,
    busy: quotaBusy,
    loadQuota,
    loadUsage,
    drop: dropQuota,
    refresh: refreshQuotaCore,
  } = useProviderQuota(root)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const fresh = await getProviderStatus()
      if (!alive.current) return null
      setStatus(fresh)
      setMessage(fresh.error ? `${fresh.error}（修好之前不能保存）` : null)
      return fresh
    } catch (err) {
      if (!alive.current) return null
      setMessage(err instanceof Error ? err.message : '读取配置失败')
      return null
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  // 打开面板就回读：期间可能有人手改了 opencode.json；顺带刷新额度与本机用量
  useEffect(() => {
    if (!open) return
    void (async () => {
      const fresh = await reload()
      if (!alive.current) return
      const ids = (fresh?.providers ?? []).map((item) => item.id)
      void loadQuota(ids)
      void loadUsage()
    })()
  }, [open, reload, loadQuota, loadUsage])

  /**
   * 手动刷新：额度与「本机已用」一起重拉。
   *
   * 单独一条 busy 状态（在 useProviderQuota 里），刷新额度时仍可正常保存/删除；
   * 反过来保存时也不该让刷新按钮灰掉。
   */
  const refreshQuota = useCallback(async () => {
    // 先回读一次配置：面板开着时它可能被账号同步 / 手改 / 另一个窗口改过，
    // 直接拿 status 快照会漏掉新加的 provider（却照样提示「已刷新」）。
    const fresh = await reload()
    const ids = (fresh?.providers ?? status?.providers ?? []).map((item) => item.id)
    const hint = await refreshQuotaCore(ids)
    if (hint) setMessage(hint)
  }, [reload, status, refreshQuotaCore])

  const edit = useCallback((info: ProviderInfo | null) => {
    setMessage(null)
    setForm(info ? formFromProvider(info) : EMPTY_FORM)
  }, [])

  const preset = useCallback((next: ProviderPreset) => {
    setMessage(null)
    setForm(presetForm(next))
  }, [])

  /**
   * 一键接入（Magpie 网关用）：套预设、马上拉模型、只勾选感兴趣的模型。
   *
   * 为什么不能「先 preset() 再 fetchModels()」：fetchModels 读的是渲染后的 form，
   * 两次调用之间 React 还没刷新，第二次拿到的仍是旧表单。这里用同一份值去拉。
   */
  const connectPreset = useCallback(
    async (next: ProviderPreset, preferPrefix = '') => {
      if (busy) return
      const base = presetForm(next)
      setForm(base)
      setMessage(null)
      setBusy(true)
      try {
        const list = await fetchProviderModels({
          id: base.id,
          baseURL: base.baseURL,
          apiKey: base.apiKey,
        })
        if (!alive.current) return
        // 不指定前缀 = 全部模型（WorkBuddy 只有一家，接就接全）
        const preferred = preferPrefix
          ? list.filter((model) => model.id.startsWith(preferPrefix)).map((model) => model.id)
          : list.map((model) => model.id)
        setForm((cur) => {
          const applied = applyRemoteModels({ ...cur, picked: preferred }, list)
          return { ...applied, picked: preferred }
        })
        setMessage(
          preferred.length > 0
            ? `已接好 ${next.name}：勾选 ${preferred.length} 个模型，点「保存」写入配置`
            : `读到 ${list.length} 个模型，但没有${preferPrefix ? ` ${preferPrefix}*` : ''}`,
        )
      } catch (err) {
        if (!alive.current) return
        setMessage(err instanceof Error ? err.message : '接入失败')
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    [busy],
  )

  const patch = useCallback((field: keyof FormState, value: string) => {
    setForm((cur) => ({ ...cur, [field]: value }))
  }, [])

  const toggle = useCallback((modelId: string) => {
    setForm((cur) => togglePicked(cur, modelId))
  }, [])

  const selectAll = useCallback((checked: boolean) => {
    setForm((cur) => setPickedAll(cur, checked))
  }, [])

  const limit = useCallback((modelId: string, field: 'context' | 'output', raw: string) => {
    setForm((cur) => updateModelLimit(cur, modelId, field, raw))
  }, [])

  const fetchModels = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    // 记住「这次是给谁拉的」：请求可能跑 20-30 秒，期间用户完全可能切换编辑对象。
    // 结果只能落到发起请求的那份表单，否则会把 A 的模型写进 B 的配置。
    const wanted = { id: form.id.trim(), baseURL: form.baseURL.trim(), apiKey: form.apiKey.trim() }
    try {
      const list = await fetchProviderModels(wanted)
      if (!alive.current) return
      setForm((cur) => {
        const same =
          cur.id.trim() === wanted.id &&
          cur.baseURL.trim() === wanted.baseURL &&
          cur.apiKey.trim() === wanted.apiKey
        return same ? applyRemoteModels(cur, list) : cur
      })
      setMessage(`拉到 ${list.length} 个模型`)
    } catch (err) {
      if (!alive.current) return
      setMessage(err instanceof Error ? err.message : '拉取模型失败')
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [busy, form.apiKey, form.baseURL, form.id])

  const save = useCallback(async () => {
    if (busy) return
    const reason = saveBlockReason(form)
    if (reason) {
      setMessage(reason)
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const providerName = form.name.trim() || form.id.trim()
      const fresh = await saveProvider(
        {
          id: form.id.trim(),
          name: providerName,
          baseURL: form.baseURL.trim(),
          apiKey: form.apiKey.trim(),
        },
        // 名字统一成「模型名 (商家名)」，并带上上下文/输出上限
        toSaveModels(form, providerName),
      )
      if (!alive.current) return
      setStatus(fresh)
      // 保存后刷新这一条的额度（换 key 了要重新查）
      void loadQuota([form.id.trim()])
      // 保存成功后把输入框里的明文 key 换成磁盘上的掩码：
      // 面板对外口径是「key 只回掩码」，别让明文一直留在 DOM 里。
      const savedId = form.id.trim()
      const saved = fresh.providers.find((item) => item.id === savedId)
      if (saved) {
        setForm((cur) => (cur.id.trim() === savedId ? { ...cur, apiKey: saved.keyMasked } : cur))
      }
      setMessage('已写入配置，打开模型下拉即可看到（没出现就重开工作台）。')
      // 通知账号同步：已登录时顺手把新配置传上去
      window.dispatchEvent(new Event(PROVIDERS_SAVED_EVENT))
    } catch (err) {
      if (!alive.current) return
      setMessage(err instanceof Error ? err.message : '保存失败')
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [busy, form, loadQuota])

  const remove = useCallback(
    async (id: string) => {
      if (busy) return
      setBusy(true)
      setMessage(null)
      try {
        const fresh = await removeProvider(id)
        if (!alive.current) return
        setStatus(fresh)
        setForm((cur) => (cur.id === id ? EMPTY_FORM : cur))
        dropQuota(id)
        setMessage(`已删除 ${id}`)
        window.dispatchEvent(new Event(PROVIDERS_SAVED_EVENT))
      } catch (err) {
        if (!alive.current) return
        setMessage(err instanceof Error ? err.message : '删除失败')
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    [busy, dropQuota],
  )

  const normalizedBase = normalizeBaseURL(form.baseURL)

  return {
    status,
    quota,
    usage,
    loading,
    busy,
    quotaBusy,
    message,
    form,
    models: visibleModels(form),
    saveDisabled: busy || !canSave(form),
    edit,
    preset,
    connectPreset,
    patch,
    fetchModels,
    save,
    remove,
    reload,
    refreshQuota,
    toggle,
    selectAll,
    limit,
    normalizedBase,
  }
}

export { canFetchModels }
