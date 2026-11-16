// 第二层验收（429 自动重投）用的两个小服务。
//
// 1. createMockModel()：假 OpenAI 兼容端点，可控制「主对话」返回 429。
//    关键：错误响应带 `x-should-retry: false`，ai-sdk 会立刻放弃重试，
//    于是 opencode 很快写出 `idle/outcome=failed`（status 429），
//    正好是工作台第二层重试要接手的那个状态。
// 2. createAuthProxy()：dev 的 vite 代理不会带认证头，这里给独立 opencode
//    实例补上 Basic 认证并顺带记录 /prompt 调用（验收要断言「重投了」）。
import http from 'node:http'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(raw)
      }
    })
  })
}

/**
 * 判是不是主对话：带 system、且最后一条 user 很短。
 * 标题生成那条 user 是长提示词，必须放行，否则会白白消耗失败预算。
 */
function kindOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const lastUser = [...messages].reverse().find((m) => m?.role === 'user')
  const hasSystem = messages.some((m) => m?.role === 'system')
  if (!lastUser || !hasSystem) return 'other'
  return String(lastUser.content ?? '').length <= 20 ? 'main' : 'title'
}

function okStream(res, model, text) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const id = `chatcmpl-mock-${Date.now()}`
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  const send = (delta, finish = null) =>
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
  send({ role: 'assistant', content: '' })
  send({ content: text })
  send({}, 'stop')
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } })}\n\n`,
  )
  res.write('data: [DONE]\n\n')
  res.end()
}

/** 假模型服务。stats.failMain 是「接下来主对话还要失败几次」。 */
export function createMockModel(port, reply = 'pong-429-ok') {
  const stats = { calls: [], failMain: 0, failCode: 429, noRetry: true, retryAfterSec: null, delayMs: 0 }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')

    if (url.pathname === '/__stats') return sendJson(res, 200, stats)
    if (url.pathname === '/__arm') {
      stats.calls = []
      stats.failMain = Number(url.searchParams.get('fail') ?? '1')
      stats.failCode = Number(url.searchParams.get('code') ?? '429')
      stats.noRetry = url.searchParams.get('noretry') !== '0'
      const after = url.searchParams.get('after')
      stats.retryAfterSec = after === null || after === '' ? null : Number(after)
      stats.delayMs = Math.max(0, Number(url.searchParams.get('delay') ?? '0') || 0)
      return sendJson(res, 200, { ok: true, ...stats, calls: undefined })
    }
    if (url.pathname === '/v1/models') {
      return sendJson(res, 200, { object: 'list', data: [{ id: 'mock-429', object: 'model' }] })
    }
    if (url.pathname !== '/v1/chat/completions') {
      return sendJson(res, 404, { error: { message: `no route ${url.pathname}` } })
    }

    const body = await readBody(req)
    const model = typeof body === 'object' && body ? (body.model ?? 'mock-429') : 'mock-429'
    const kind = kindOf(body)
    const fail = kind === 'main' && stats.failMain > 0
    if (fail) stats.failMain -= 1
    stats.calls.push({ at: Date.now(), kind, code: fail ? stats.failCode : 200 })

    if (fail) {
      const headers = stats.retryAfterSec === null ? {} : { 'retry-after': String(stats.retryAfterSec) }
      if (stats.noRetry) headers['x-should-retry'] = 'false'
      const code = stats.failCode
      const message =
        code === 429
          ? 'Rate limit reached for mock-429 (simulated)'
          : `Simulated upstream error ${code} for mock-429`
      return sendJson(res, code, { error: { message, type: code === 429 ? 'rate_limit_error' : 'server_error' } }, headers)
    }

    if (!body?.stream) {
      return sendJson(res, 200, {
        id: `chatcmpl-mock-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      })
    }
    // 成功响应故意拖慢：用来压「重投成功后又被删一次」的竞态
    if (stats.delayMs > 0) await sleep(stats.delayMs)
    else await sleep(100)
    okStream(res, model, reply)
  })

  return { server, stats }
}

/**
 * 转发代理：给独立 opencode 实例补 Basic 认证，并记下每次 /prompt 的请求体。
 * 只做透传，不缓冲（SSE 必须流式过去）。
 */
export function createAuthProxy(port, upstreamPort, password) {
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  const stats = { prompts: [], reverts: [], promptFails: 0 }
  /** 故障注入：首发之后的第 N 次 /prompt 返回 500（默认 0 = 不注入） */
  let promptFailLeft = 0
  /** 这个会话已经收到几次 /prompt（首发也算），用来区分「首发」和「重投」 */
  let promptSeen = 0
  /** 故障注入：revert/stage 转发前等多久（毫秒），用来制造「stage 在飞时切走」 */
  let stageDelayMs = 0

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/__stats') return sendJson(res, 200, stats)
    if (url.pathname === '/__arm') {
      stats.prompts = []
      stats.reverts = []
      stats.promptFails = 0
      promptFailLeft = Math.max(0, Number(url.searchParams.get('promptFail') ?? '0') || 0)
      promptSeen = 0
      stageDelayMs = Math.max(0, Number(url.searchParams.get('stageDelay') ?? '0') || 0)
      return sendJson(res, 200, { ok: true, promptFailLeft, stageDelayMs })
    }

    const isPrompt = req.method === 'POST' && /^\/api\/session\/[^/]+\/prompt$/.test(url.pathname)
    const revertMatch = req.method === 'POST' ? /^\/api\/session\/[^/]+\/revert\/(stage|commit)$/.exec(url.pathname) : null

    if (isPrompt || revertMatch) {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        let body = null
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          body = null
        }
        if (isPrompt) {
          stats.prompts.push({
            at: Date.now(),
            id: body?.id ?? null,
            text: body?.text ?? '',
            resume: body?.resume ?? null,
          })
        } else if (revertMatch) {
          stats.reverts.push({
            at: Date.now(),
            action: revertMatch[1],
            messageID: body?.messageID ?? null,
            files: body?.files ?? null,
          })
        }
      })
    }

    // 故障注入一：重投那次 /prompt 直接 500（验证「已回撤但没发出去」的兜底）
    if (isPrompt) promptSeen += 1
    if (isPrompt && promptSeen > 1 && promptFailLeft > 0) {
      promptFailLeft -= 1
      stats.promptFails += 1
      return sendJson(res, 500, { error: 'simulated prompt failure (injected)' })
    }
    // 故障注入二：让 stage 慢一点，制造「服务端已经 stage、前端还在等响应」的窗口
    if (revertMatch && revertMatch[1] === 'stage' && stageDelayMs > 0) await sleep(stageDelayMs)

    const headers = { ...req.headers, host: `127.0.0.1:${upstreamPort}`, authorization: auth }
    delete headers['x-oc-token']
    delete headers.origin
    delete headers.referer

    const upstream = http.request(
      { host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', (err) => {
      if (!res.headersSent) sendJson(res, 502, { error: `proxy: ${err.message}` })
      else res.end()
    })
    req.pipe(upstream)
  })

  return { server, stats }
}
