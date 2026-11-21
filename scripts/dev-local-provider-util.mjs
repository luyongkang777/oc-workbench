// dev provider 插件的小工具：错误、响应、读请求体。
// 从 dev-local-provider.mjs 拆出来，供 store / models / quota / 主文件共用。

/** 单次请求体上限：一份账号配置（100 个 provider）也就几百 KB。 */
export const BODY_LIMIT = 512 * 1024

export function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

/** 本机梯子转发的目标（与 shell/src/relay.rs 的 TARGETS 一致）。 */
const RELAY_TARGETS = {
  go: 'https://opencode.ai/inference/go/openai/v1',
  cc: 'https://api.commandcode.ai/provider/v1',
}

/**
 * 本机 relay 地址 → 上游地址；不是 relay 就原样返回。
 *
 * 磁盘配置里 OpenCode Go / Command Code 的 baseURL 会被换成
 * `http://127.0.0.1:<port>/local/relay/<secret>/go|cc`。外壳展示时会还原，
 * dev 也得还原，否则额度识别会认不出服务商（整行额度空白），图标也会退化成首字母。
 */
export function upstreamOf(url) {
  const text = String(url ?? '').trim().replace(/\/+$/, '')
  const marker = '/local/relay/'
  const index = text.indexOf(marker)
  if (index < 0) return url
  const head = text.slice(0, index)
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/i.test(head)) return url
  const parts = text.slice(index + marker.length).split('/')
  const key = parts.length > 1 ? parts[1] : parts[0]
  return RELAY_TARGETS[key] || url
}

export function sendJson(res, status, data) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(data))
}

export async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > BODY_LIMIT) throw httpError(413, '请求体过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function readJson(req) {
  const raw = await readBody(req)
  let parsed
  try {
    parsed = JSON.parse(raw.toString('utf8') || '{}')
  } catch (err) {
    throw httpError(400, `请求体不是 JSON：${err.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError(400, '请求体必须是 JSON 对象')
  }
  return parsed
}
