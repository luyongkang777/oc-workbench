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
import { fetchModelsMessage, filterModels } from '../api/providerFree'
import { PROVIDERS_SAVED_EVENT } from './useProviderSync'
import type { ProviderController } from './providerController'
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
      // 过滤模式下说清「上游给了 N 个、只留 M 个」——文案逻辑在 providerFree.fetchModelsMessage
      const kept = filterModels(list, form.filter).length
      setMessage(fetchModelsMessage(list.length, kept, form.filter))

      // 提示要与实际结果对上：protected 生效时表单并没有被改写（见 applyRemoteModels 的保护分支），
      // 若照常说「只保留 N 个」会让人以为清单已经换成新的，实际还是旧的。
      if (list.length > 0 && kept === 0 && form.filter !== '' && form.models.length > 0) {
        setMessage(
          `上游这次没返回可用模型（可能没标记免费），已保留现有 ${form.models.length} 个配置，` +
            '没有改动。稍后可再试，或切到「自定义」手动调整。',
        )
      }
    } catch (err) {
      if (!alive.current) return
      setMessage(err instanceof Error ? err.message : '拉取模型失败')
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [busy, form.apiKey, form.baseURL, form.filter, form.id])

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
export type { ProviderController } from './providerController'
