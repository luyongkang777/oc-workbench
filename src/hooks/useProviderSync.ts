import { useCallback, useEffect, useRef, useState } from 'react'
import { ACCOUNT_EVENT } from '../api/gateway'
import {
  accountName,
  buildLocalProfile,
  isAccountLoggedIn,
  pullAndApply,
  pushProfile,
  setDefaultModel,
  type SyncState,
} from '../api/providerSync'

/** provider 保存/删除后广播：同步钩子据此自动上传。 */
export const PROVIDERS_SAVED_EVENT = 'oc-providers-saved'
/** 云端配置应用成功后广播：模型下拉据此刷新。 */
export const PROVIDERS_APPLIED_EVENT = 'oc-providers-applied'

/**
 * 账号级配置同步。
 *
 * 三条规则：
 *   1. 登录状态下**每次启动拉一次**（换电脑就是这个场景）；
 *   2. 本地 provider 有改动 → 自动上传（防抖 800ms，避免连点几次保存传几次）；
 *   3. 没登录就什么都不做，界面提示「登录后可同步」。
 */
function trace(step: string, detail: unknown) {
  try {
    const w = window as unknown as { __ocSync?: unknown[] }
    w.__ocSync = w.__ocSync ?? []
    w.__ocSync.push({ at: Date.now(), step, detail })
  } catch {
    /* 忽略 */
  }
}

export function useProviderSync() {
  const [state, setState] = useState<SyncState>({
    loggedIn: isAccountLoggedIn(),
    username: accountName(),
    hasRemote: false,
    message: '',
    busy: false,
  })
  const alive = useRef(true)
  const timer = useRef<number | null>(null)
  const pulledOnce = useRef(false)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  const push = useCallback(async (silent = false) => {
    if (!isAccountLoggedIn()) {
      if (!silent) {
        setState((cur) => ({ ...cur, loggedIn: false, message: '未登录，无法同步' }))
      }
      return
    }
    setState((cur) => ({ ...cur, busy: true }))
    try {
      const profile = await buildLocalProfile()
      trace('push:start', { providers: profile.providers.length })
      const result = await pushProfile(profile)
      trace('push:done', result)
      if (!alive.current) return
      setState((cur) => ({
        ...cur,
        busy: false,
        loggedIn: true,
        username: accountName(),
        hasRemote: true,
        updatedAt: result.updatedAt,
        message: `已上传 ${profile.providers.length} 个服务商${silent ? '' : '到账号'}`,
      }))
    } catch (err) {
      if (!alive.current) return
      setState((cur) => ({
        ...cur,
        busy: false,
        message: err instanceof Error ? err.message : '上传失败',
      }))
    }
  }, [])

  const pull = useCallback(async (silent = false) => {
    if (!isAccountLoggedIn()) {
      setState((cur) => ({ ...cur, loggedIn: false, message: '未登录，无法同步' }))
      return
    }
    setState((cur) => ({ ...cur, busy: true }))
    try {
      trace('pull:start', { loggedIn: isAccountLoggedIn() })
      const result = await pullAndApply()
      trace('pull:done', result ? { applied: result.applied } : 'remote-empty')
      if (!alive.current) return
      if (result) {
        setState((cur) => ({
          ...cur,
          busy: false,
          loggedIn: true,
          username: accountName(),
          hasRemote: true,
          message: `已从账号恢复 ${result.applied} 个服务商`,
        }))
        try {
          window.dispatchEvent(new Event(PROVIDERS_APPLIED_EVENT))
        } catch {
          /* 非浏览器环境忽略 */
        }
      } else {
        setState((cur) => ({
          ...cur,
          busy: false,
          loggedIn: true,
          username: accountName(),
          hasRemote: false,
          message: silent ? '' : '账号里还没有配置，改完 provider 会自动上传',
        }))
        // 账号里还没有配置：把本机现有的传上去做「种子」。
        // 这是换新电脑/第一次开同步的场景，否则用户得手动点一次「上传」。
        if (silent) void push(true)
      }
    } catch (err) {
      trace('pull:error', err instanceof Error ? err.message : String(err))
      if (!alive.current) return
      setState((cur) => ({
        ...cur,
        busy: false,
        message: err instanceof Error ? err.message : '拉取失败',
      }))
    }
  }, [])

  // 启动/登录变化时拉一次（同一次启动只自动拉一次，避免每次开面板都覆盖本地）
  useEffect(() => {
    const run = () => {
      if (!isAccountLoggedIn()) {
        setState((cur) => ({ ...cur, loggedIn: false, username: '', message: '' }))
        return
      }
      if (pulledOnce.current) return
      pulledOnce.current = true
      void pull(true)
    }
    // 等第一帧结束，避免和首屏模型拉取抢带宽
    const handle = window.setTimeout(run, 1200)
    window.addEventListener(ACCOUNT_EVENT, run)
    return () => {
      window.clearTimeout(handle)
      window.removeEventListener(ACCOUNT_EVENT, run)
    }
  }, [pull])

  // 本地 provider 改动 → 防抖上传
  useEffect(() => {
    const onSaved = () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        timer.current = null
        void push(true)
      }, 800)
    }
    window.addEventListener(PROVIDERS_SAVED_EVENT, onSaved)
    return () => window.removeEventListener(PROVIDERS_SAVED_EVENT, onSaved)
  }, [push])

  /** 改默认模型：写本地，再上传。 */
  const setModel = useCallback(
    async (model: string) => {
      try {
        await setDefaultModel(model)
        if (isAccountLoggedIn()) await push(true)
        setState((cur) => ({ ...cur, message: `默认模型已设为 ${model}`, hasRemote: true }))
      } catch (err) {
        setState((cur) => ({
          ...cur,
          message: err instanceof Error ? err.message : '设置默认模型失败',
        }))
      }
    },
    [push],
  )

  return { state, push, pull, setModel }
}

export type ProviderSyncController = ReturnType<typeof useProviderSync>
