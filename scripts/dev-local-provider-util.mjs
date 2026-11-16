// dev provider 插件的小工具：错误、响应、读请求体。
// 从 dev-local-provider.mjs 拆出来，供 store / models / quota / 主文件共用。

/** 单次请求体上限：一份账号配置（100 个 provider）也就几百 KB。 */
export const BODY_LIMIT = 512 * 1024

export function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
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
