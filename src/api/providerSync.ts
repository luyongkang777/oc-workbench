import { getGatewayToken, getGatewayUrl, getGatewayUser } from './gateway'
import type { SaveModel } from './provider'
import { localRequest } from './client'

/**
 * 账号级配置同步：把「第三方 API 接入」里的 provider（含 SK、baseURL、模型/上下文）
 * 和默认模型存到账号下；换电脑登录同一账号后自动拉下来写进本地 `opencode.json`。
 *
 * 网关侧：`GET/POST /portal/api/profile`（Bearer token，只能读写自己那份，见 profile_api.go）。
 * 本地侧：`POST /local/provider/apply`（一次写入多个 provider + 默认模型，只留一份备份）。
 *
 * 为什么不走 localStorage：换电脑就没有了，必须是账号级。
 */

export type SyncProvider = {
  id: string
  name: string
  baseURL: string
  apiKey: string
  models: SaveModel[]
}

export type SyncProfile = {
  providers: SyncProvider[]
  /** opencode.json 顶层的默认模型（`providerID/modelID`） */
  model?: string
}

export type SyncState = {
  loggedIn: boolean
  username: string
  /** 云端有没有存过配置 */
  hasRemote: boolean
  /** 最近一次同步结果 */
  message: string
  busy: boolean
  /** 云端配置的更新时间（秒） */
  updatedAt?: number
}

export function isAccountLoggedIn(): boolean {
  return Boolean(getGatewayToken())
}

export function accountName(): string {
  return getGatewayUser()
}

/** 拉云端配置；没登录/没存过返回 null。 */
export async function pullProfile(): Promise<SyncProfile | null> {
  const token = getGatewayToken()
  if (!token) return null
  const host = getGatewayUrl()
  const res = await fetch(`${host}/portal/api/profile`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`读取账号配置失败：HTTP ${res.status}`)
  const text = await res.text()
  if (!text.trim()) return null
  const data = JSON.parse(text) as { profile?: SyncProfile | null }
  if (!data.profile) return null
  return data.profile
}

/** 推云端：把本机所有 provider + 默认模型整份覆盖上去。 */
export async function pushProfile(profile: SyncProfile): Promise<{ updatedAt?: number }> {
  const token = getGatewayToken()
  if (!token) throw new Error('未登录')
  const host = getGatewayUrl()
  const res = await fetch(`${host}/portal/api/profile`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(profile),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`保存账号配置失败：HTTP ${res.status}${detail ? ` ${detail.slice(0, 120)}` : ''}`)
  }
  return (await res.json()) as { updatedAt?: number }
}

/**
 * 取本机现状（**带真 key**），组装成要同步的配置。
 *
 * status 只回掩码，所以这里走 `/local/provider/export`；
 * 它的权限级与读 opencode.json 相同，不是新暴露面。
 */
export async function buildLocalProfile(): Promise<SyncProfile> {
  const data = await localRequest<{
    ok?: boolean
    error?: string
    model?: string
    providers?: Array<{
      id: string
      name: string
      baseURL: string
      apiKey: string
      models: Array<{ id: string; name: string; context: number; output: number }>
    }>
  }>('/local/provider/export', undefined, 20_000)
  if (data.ok === false) throw new Error(data.error || '导出本机配置失败')
  return {
    model: data.model || '',
    providers: (data.providers ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      baseURL: item.baseURL,
      apiKey: item.apiKey,
      models: (item.models ?? []).map((model) => ({
        id: model.id,
        name: model.name,
        context: model.context ?? 0,
        output: model.output ?? 0,
      })),
    })),
  }
}

/** 把云端配置写进本机 opencode.json（一次改完）。 */
export async function applyProfile(profile: SyncProfile): Promise<{ applied: number }> {
  const providers = (profile.providers ?? []).filter(
    (item) => item?.id && item.baseURL && item.apiKey,
  )
  const model = (profile.model ?? '').trim()
  if (providers.length === 0 && !model) return { applied: 0 }
  const data = await localRequest<{ applied?: number }>(
    '/local/provider/apply',
    undefined,
    30_000,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providers, model }),
    },
  )
  return { applied: data.applied ?? providers.length }
}

/**
 * 拉云端并应用到本机。
 *
 * 返回 null 表示「账号里没有配置」（首次登录/没同步过），调用方据此提示用户。
 */
export async function pullAndApply(): Promise<{ profile: SyncProfile; applied: number } | null> {
  const profile = await pullProfile()
  if (!profile) return null
  const { applied } = await applyProfile(profile)
  return { profile, applied }
}

/** 只改默认模型（写 opencode.json 顶层 model）。 */
export async function setDefaultModel(model: string): Promise<void> {
  await localRequest('/local/provider/apply', undefined, 20_000, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providers: [], model }),
  })
}

/** 本机 → 云端（provider 的 key 由调用方给真值，status 只有掩码）。 */
export async function pushLocal(
  providers: SyncProvider[],
  model: string,
): Promise<{ updatedAt?: number }> {
  return pushProfile({ providers, model })
}
