import { localRequest } from './client'
import { normalizeBaseURL, type ModelOption, type ProviderDraft } from './providerFormat'

/**
 * 第三方 API 接入：`/local/provider/*`（外壳与 dev 两套实现，字段逐字一致）。
 *
 * 密钥只以掩码形式进出：`status` 回 `keyMasked`，保存时如果用户没改 key，
 * 把掩码原样传回去，外壳会从磁盘读回真 key 再写（不会把 `sk-1…cdef` 存进配置）。
 */

/** 配置里已有的一条模型（带上下文/输出上限）。 */
export type ProviderModel = ModelOption

/** 配置里已有的一条 provider（**不含明文 key**）。 */
export type ProviderInfo = {
  id: string
  name: string
  npm: string
  baseURL: string
  keyMasked: string
  hasKey: boolean
  modelCount: number
  models: ProviderModel[]
}

export type ProviderStatus = {
  ok: boolean
  /** opencode.json 的绝对路径（界面要显示「写到哪了」）。 */
  path?: string
  exists?: boolean
  /** 文件解析失败的原因：非空时保存会被拒（409），界面要提前警告。 */
  error?: string
  providers: ProviderInfo[]
  /** 刚保存成功的 provider id（只有 save 的响应带）。 */
  saved?: string
  /** opencode.json 顶层的默认模型（`providerID/modelID`）。 */
  model?: string
  /** apply 接口实际写入的 provider 数量。 */
  applied?: number
}

/** 保存时提交的一条模型。 */
export type SaveModel = {
  id: string
  /** 「DeepSeek V4.1 Flash (OpenCode Go)」这种带商家名的显示名 */
  name: string
  context: number
  output: number
}

export async function getProviderStatus(): Promise<ProviderStatus> {
  return localRequest<ProviderStatus>('/local/provider/status')
}

/** 拉模型列表（带 name / context / output）。`apiKey` 可以是掩码（外壳会按 id 从磁盘读回真 key）。 */
export async function fetchProviderModels(
  draft: Pick<ProviderDraft, 'baseURL' | 'apiKey'> & { id?: string },
): Promise<ModelOption[]> {
  const data = await localRequest<{ ok?: boolean; models?: ModelOption[] }>(
    '/local/provider/models',
    undefined,
    30_000,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: draft.id ?? '',
        baseURL: normalizeBaseURL(draft.baseURL) || draft.baseURL,
        apiKey: draft.apiKey,
      }),
    },
  )
  return data.models ?? []
}

/** 保存一条 provider（新增或覆盖同 id）。 */
export async function saveProvider(
  draft: ProviderDraft,
  models: SaveModel[],
): Promise<ProviderStatus> {
  return localRequest<ProviderStatus>('/local/provider/save', undefined, 30_000, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: draft.id.trim(),
      name: draft.name.trim() || draft.id.trim(),
      baseURL: normalizeBaseURL(draft.baseURL) || draft.baseURL,
      apiKey: draft.apiKey.trim(),
      models,
    }),
  })
}

/** 删除一条 provider。 */
export async function removeProvider(id: string): Promise<ProviderStatus> {
  return localRequest<ProviderStatus>('/local/provider/remove', undefined, 20_000, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  })
}
