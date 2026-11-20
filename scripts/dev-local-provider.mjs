// dev server 的第三方 API 接入接口，对齐 Rust 外壳的 `/local/provider/*`。
//
// 为什么要在 dev 里单独实现一份：`npm run dev` 时 `/local/*` 全部由 Vite 插件处理
// （不会转发给外壳），少了这份实现，接入面板在 dev 里恒为错误态。
//
// 语义与 `shell/src/provider.rs` 一致：
//   GET  /local/provider/status   已有 provider 列表（key 只有掩码）
//   GET  /local/provider/export   带真 key 的导出（账号同步用）
//   POST /local/provider/models   {baseURL, apiKey} → 拉 /models
//   POST /local/provider/test     同上，只是语义上探通
//   POST /local/provider/save     {id, name, baseURL, apiKey, models[]}
//   POST /local/provider/apply    批量写 provider + 默认模型（账号同步）
//   POST /local/provider/remove   {id}
//   GET  /local/provider/quota    额度（DeepSeek 金额 / 其它给控制台）
//
// 拆分成四个文件：util（错误与请求体）、store（配置读写）、models（拉模型）、quota（额度）。
// 只在 `npm run dev` 下生效，打包产物里不存在。

import { httpError, readJson, sendJson } from './dev-local-provider-util.mjs'
import {
  configPath,
  keyFromDisk,
  readConfig,
  readStatus,
  removeProvider,
  saveConfig,
  upsertProvider,
} from './dev-local-provider-store.mjs'
import { fetchModels, isMasked } from './dev-local-provider-models.mjs'
import { providerQuota } from './dev-local-provider-quota.mjs'

export { configPath, maskKey, readStatus, saveConfig, upsertProvider, removeProvider } from './dev-local-provider-store.mjs'
export { pickModelIds, pickModelOptions } from './dev-local-provider-models.mjs'
export { parseSaveModels }

/**
 * 保存请求里的 `models` → 上游能认的数组。
 *
 * 两种写法都要收：纯字符串 `"id"` 与对象 `{id,name,context,output}`。
 * 之前这里只留字符串、把对象丢掉，导致面板勾完保存后**模型一个都没写进去**：
 * Rust 侧 `parse_models` 两种都认，dev 口径不同 → 只有 exe 里能用，dev 验收看不出来。
 */
function parseSaveModels(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const raw of value) {
    if (typeof raw === 'string') {
      const id = raw.trim()
      if (id) out.push(id)
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    // 没有有效 id 的对象留不下来（写进配置会变成一个空键）
    if (!String(raw.id ?? '').trim()) continue
    out.push(raw)
  }
  return out
}

/**
 * 前端把掩码原样传回来（用户没改 key）：按同一个 id 从磁盘读回真 key。
 *
 * 与 Rust 的 `is_masked` + `read_key_for` 同口径。这个函数在 9f0d511 拆分时漏掉了，
 * 导致 dev 里「获取模型 / 保存」直接 500（`resolveKey is not defined`），
 * 只有 exe 里能用 —— 真机验收时才发现。
 */
function resolveKey(map) {
  const apiKey = String(map.apiKey ?? '').trim()
  if (!isMasked(apiKey)) return apiKey
  const id = String(map.id ?? '').trim()
  return id ? keyFromDisk(apiKey, id) : ''
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const action = url.pathname.split('/').pop()

  if (action === 'status') {
    if (req.method !== 'GET') throw httpError(405, '状态只支持 GET')
    sendJson(res, 200, readStatus())
    return
  }

  if (action === 'quota') {
    if (req.method !== 'GET') throw httpError(405, '额度只支持 GET')
    const id = String(url.searchParams.get('id') || '').trim()
    if (!id) throw httpError(400, '缺少 id')
    sendJson(res, 200, await providerQuota(id))
    return
  }

  if (action === 'export') {
    // 带真 key 的本机导出：只给账号同步用（与读 opencode.json 同权限级）
    const { value, error } = readConfig()
    if (error) throw httpError(409, error)
    const providers = []
    for (const [id, entry] of Object.entries(value?.provider || {})) {
      const baseURL = entry?.options?.baseURL || ''
      const apiKey = entry?.options?.apiKey || ''
      if (!baseURL || !String(apiKey).trim()) continue
      providers.push({
        id,
        name: entry?.name || id,
        baseURL,
        apiKey,
        models: Object.entries(entry?.models || {}).map(([key, item]) => ({
          id: key,
          name: item?.name || key,
          context: Number(item?.limit?.context) || 0,
          output: Number(item?.limit?.output) || 0,
        })),
      })
    }
    sendJson(res, 200, {
      ok: true,
      model: typeof value?.model === 'string' ? value.model : '',
      providers,
    })
    return
  }

  if (req.method !== 'POST') throw httpError(405, `${action} 只支持 POST`)
  const map = await readJson(req)

  if (action === 'models' || action === 'test') {
    const baseURL = String(map.baseURL ?? '').trim()
    if (!baseURL) throw httpError(400, '缺少 baseURL')
    const apiKey = await resolveKey(map)
    if (!apiKey) throw httpError(400, '缺少 apiKey')
    const models = await fetchModels(baseURL, apiKey)
    sendJson(res, 200, action === 'test' ? { ok: true, count: models.length, models } : { ok: true, models })
    return
  }

  if (action === 'save') {
    const id = String(map.id ?? '').trim()
    if (!id) throw httpError(400, '缺少 id')
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw httpError(400, 'id 只能用字母、数字、点、下划线、短横线')
    if (id.length > 64) throw httpError(400, 'id 太长（最多 64 个字符）')
    const baseURL = String(map.baseURL ?? '').trim()
    if (!/^https?:\/\//i.test(baseURL)) throw httpError(400, '接口地址必须是完整的 http(s) 地址')
    const apiKey = await resolveKey(map)
    if (!apiKey) throw httpError(400, '缺少 apiKey')
    if (/\s/.test(apiKey)) throw httpError(400, 'API Key 里不能有空格或换行')
    const models = parseSaveModels(map.models)
    saveConfig((config) =>
      upsertProvider(config, { id, name: String(map.name ?? '').trim() || id, baseURL, apiKey, models }),
    )
    sendJson(res, 200, { ...readStatus(), saved: id })
    return
  }

  if (action === 'apply') {
    // 账号同步：一次写入多个 provider + 可选默认模型（与 Rust 的 apply_endpoint 同口径）
    const list = Array.isArray(map.providers) ? map.providers : []
    const model = String(map.model ?? '').trim()
    if (list.length === 0 && !model) throw httpError(400, 'providers 与 model 至少要有一个')

    const prepared = []
    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw httpError(400, 'providers 里每项必须是对象')
      }
      const id = String(raw.id ?? '').trim()
      if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw httpError(400, 'provider id 不合法')
      const baseURL = String(raw.baseURL ?? '').trim()
      if (!/^https?:\/\//i.test(baseURL)) throw httpError(400, 'provider 的 baseURL 不合法')
      const apiKey = String(raw.apiKey ?? '').trim()
      if (!apiKey) throw httpError(400, 'provider 缺少 apiKey')
      prepared.push({
        id,
        name: String(raw.name ?? id).trim() || id,
        baseURL,
        apiKey,
        models: Array.isArray(raw.models) ? raw.models : [],
      })
    }

    saveConfig((config) => {
      for (const item of prepared) upsertProvider(config, item)
      if (model) {
        // 默认模型指向本机没有的 provider 时保留原值（换机场景）
        const providerId = model.split('/')[0]
        if (config.provider && Object.prototype.hasOwnProperty.call(config.provider, providerId)) {
          config.model = model
        }
      }
    })
    sendJson(res, 200, { ...readStatus(), applied: prepared.length })
    return
  }

  if (action === 'remove') {
    const id = String(map.id ?? '').trim()
    if (!id) throw httpError(400, '缺少 id')
    saveConfig((config) => removeProvider(config, id))
    sendJson(res, 200, readStatus())
    return
  }

  throw httpError(404, '未知的 provider 接口')
}

export function localProviderPlugin() {
  return {
    name: 'oc-workbench-local-provider',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/local/provider')) {
          next()
          return
        }
        handle(req, res).catch((err) => {
          sendJson(res, err.status || 500, { error: err.message || String(err), status: err.status || 500 })
        })
      })
    },
  }
}

