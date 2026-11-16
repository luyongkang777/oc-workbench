// dev 的「拉上游模型列表」实现（对齐 shell/src/provider_models.rs）。

import { httpError } from './dev-local-provider-util.mjs'

const NET_TIMEOUT = 20_000

export function pickModelOptions(payload) {
  const out = []
  const push = (item) => {
    if (typeof item === 'string') {
      const id = item.trim()
      if (id && !out.some((seen) => seen.id === id)) out.push({ id, name: id, context: 0, output: 0 })
      return
    }
    const id = [item?.id, item?.name, item?.model].find((value) => typeof value === 'string' && value.trim())
    if (!id) return
    const key = id.trim()
    if (out.some((seen) => seen.id === key)) return
    const limit = item?.limit || {}
    const context =
      Number(limit.context) || Number(item?.context_length) || Number(item?.context_window) || 0
    const output = Number(limit.output) || Number(item?.max_output_tokens) || 0
    out.push({
      id: key,
      name: typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : key,
      context,
      output,
    })
  }
  if (Array.isArray(payload)) {
    payload.forEach(push)
    return out
  }
  for (const field of ['data', 'models']) {
    if (Array.isArray(payload?.[field])) payload[field].forEach(push)
  }
  return out
}

/** 兼容旧名字（只取 id）。 */
export function pickModelIds(payload) {
  return pickModelOptions(payload).map((item) => item.id)
}

function legacyPickModelIds(payload) {
  // 旧实现，保留仅为减少 diff；实际调用点已改用 pickModelOptions
  const out = []
  const push = (item) => {
    if (typeof item === 'string') {
      const text = item.trim()
      if (text && !out.includes(text)) out.push(text)
      return
    }
    for (const field of ['id', 'name', 'model']) {
      const text = item?.[field]
      if (typeof text === 'string' && text.trim()) {
        if (!out.includes(text.trim())) out.push(text.trim())
        return
      }
    }
  }
  if (Array.isArray(payload)) {
    payload.forEach(push)
    return out
  }
  for (const field of ['data', 'models']) {
    if (Array.isArray(payload?.[field])) payload[field].forEach(push)
  }
  return out
}

export async function fetchModels(baseURL, apiKey) {
  const url = `${String(baseURL).replace(/\/+$/, '')}/models`
  let res
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(NET_TIMEOUT),
    })
  } catch (err) {
    throw httpError(502, `连不上 ${url}：${err.message}`)
  }
  const text = await res.text()
  if (!res.ok) {
    let detail = ''
    try {
      const body = JSON.parse(text)
      detail = body?.error?.message || body?.error?.detail || body?.message || ''
    } catch {
      detail = text.slice(0, 120)
    }
    throw httpError(502, detail ? `上游返回 HTTP ${res.status}：${detail}` : `上游返回 HTTP ${res.status}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw httpError(502, `上游返回的不是 JSON：${text.slice(0, 120)}`)
  }
  const models = pickModelOptions(parsed)
  if (models.length === 0) throw httpError(502, '上游没有返回任何模型（响应里找不到 id / data / models）')
  return models
}

export function isMasked(key) {
  const text = String(key ?? '').trim()
  return text.length > 0 && (text.includes('…') || [...text].every((c) => c === '*'))
}
