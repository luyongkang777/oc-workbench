import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const ENDPOINT = 'https://copilot.tencent.com'
const APP = '5.9.3'
const CLI = '2.165.0'
const PENDING = 11217
const NET_TIMEOUT = 20000

const MODELS = [
  ['auto', 'Auto', 168000, 0],
  ['hy4-preview-f', 'Hy4 preview', 1000000, 0],
  ['hy3', 'Hy3', 192000, 0],
  ['hy3-x', 'Hy3-X', 192000, 0],
  ['deepseek-v4.1-flash', 'Deepseek-V4.1-Flash', 1000000, 128000],
  ['glm-5.3', 'GLM-5.3', 1000000, 0],
  ['glm-5.3-flash', 'GLM-5.3-Flash', 1000000, 131072],
  ['glm-5.2', 'GLM-5.2', 1000000, 0],
  ['glm-5.1', 'GLM-5.1', 200000, 0],
  ['glm-5v-turbo', 'GLM-5v-Turbo', 200000, 0],
  ['minimax-m3', 'MiniMax-M3', 512000, 0],
  ['kimi-k3-1', 'Kimi-K3', 1000000, 0],
  ['kimi-k2.7', 'Kimi-K2.7-Code', 256000, 0],
  ['kimi-k2.6', 'Kimi-K2.6', 256000, 0],
  ['deepseek-v4-pro', 'Deepseek-V4-Pro', 1000000, 128000],
]

function dir() {
  return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'oc-workbench')
}

function authPath() {
  return path.join(dir(), 'workbuddy.json')
}

function settingsPath() {
  return path.join(dir(), 'settings.json')
}

function loadAuth() {
  try {
    const v = JSON.parse(readFileSync(authPath(), 'utf8'))
    return {
      access: String(v.access || ''),
      refresh: String(v.refresh || ''),
      expires: Number(v.expires || 0),
      refreshExpiresAt: Number(v.refreshExpiresAt || 0),
      uid: String(v.uid || ''),
      domain: String(v.domain || ''),
      account: String(v.account || ''),
      enterpriseId: String(v.enterpriseId || ''),
    }
  } catch {
    return { access: '', refresh: '', expires: 0, refreshExpiresAt: 0, uid: '', domain: '', account: '', enterpriseId: '' }
  }
}

function saveAuth(auth) {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(authPath(), JSON.stringify(auth), 'utf8')
}

function localKey() {
  mkdirSync(dir(), { recursive: true })
  let map = {}
  try {
    map = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  } catch {
    map = {}
  }
  if (map.workbuddyKey) return String(map.workbuddyKey)
  map.workbuddyKey = `wb-${randomBytes(24).toString('hex')}`
  writeFileSync(settingsPath(), JSON.stringify(map), 'utf8')
  return map.workbuddyKey
}

function statusValue() {
  const auth = loadAuth()
  return {
    ok: true,
    configured: Boolean(auth.access || auth.refresh),
    account: auth.account,
    uid: auth.uid,
    domain: auth.domain,
    enterpriseId: auth.enterpriseId,
    expires: auth.expires,
    refreshExpiresAt: auth.refreshExpiresAt,
    endpoint: ENDPOINT,
    path: '/local/workbuddy/v1',
    apiKey: localKey(),
  }
}

async function raw(method, apiPath, headers = {}, body) {
  const res = await fetch(ENDPOINT + apiPath, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': `WorkBuddy/${APP}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(NET_TIMEOUT),
  })
  const text = await res.text()
  let value
  try {
    value = JSON.parse(text)
  } catch {
    value = text
  }
  return { status: res.status, value }
}

function sendJson(res, status, data) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(data))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname

  if (p === '/local/workbuddy/status') {
    return sendJson(res, 200, statusValue())
  }

  if (p === '/local/workbuddy/login/start') {
    const { value } = await raw('POST', '/v2/plugin/auth/state?platform=workbuddy', {
      'x-no-authorization': 'true',
      'x-no-user-id': 'true',
      'x-no-enterprise-id': 'true',
      'x-no-department-info': 'true',
    }, {})
    const data = value?.data || {}
    return sendJson(res, 200, data.state && data.authUrl
      ? { ok: true, state: data.state, url: data.authUrl }
      : { ok: false, error: value?.msg || 'WorkBuddy 没有返回登录页地址' })
  }

  if (p === '/local/workbuddy/login/poll') {
    const state = url.searchParams.get('state') || ''
    if (!state) return sendJson(res, 400, { error: '缺少 state' })
    const { status, value } = await raw('GET', `/v2/plugin/auth/token?state=${encodeURIComponent(state)}`)
    if (Number(value?.code) === PENDING) return sendJson(res, 200, { ok: true, pending: true })
    if (status >= 400 || Number(value?.code) !== 0) {
      return sendJson(res, 200, {
        ok: false,
        pending: false,
        error: `WorkBuddy 登录失败（HTTP ${status}，code ${value?.code}，${value?.msg || ''}）`,
      })
    }
    const data = value?.data || {}
    if (!data.accessToken) return sendJson(res, 200, { ok: false, pending: false, error: 'WorkBuddy 没有返回令牌' })
    const auth = loadAuth()
    auth.access = data.accessToken
    if (data.refreshToken) auth.refresh = data.refreshToken
    if (data.domain) auth.domain = data.domain
    if (data.expiresAt > 0) auth.expires = data.expiresAt
    else if (data.expiresIn > 0) auth.expires = Date.now() + data.expiresIn * 1000
    try {
      const who = await raw('GET', `/v2/plugin/login/account?state=${encodeURIComponent(state)}&platform=workbuddy`, {
        authorization: `Bearer ${auth.access}`,
        'x-domain': auth.domain || 'copilot.tencent.com',
        'x-no-user-id': 'true',
        'x-no-enterprise-id': 'true',
      })
      const account = who.value?.data || {}
      auth.uid = String(account.uid || '')
      auth.account = String(account.nickname || account.phoneNumber || '')
      auth.enterpriseId = String(account.enterpriseId || '')
    } catch {
      // 账号信息只是展示用
    }
    saveAuth(auth)
    return sendJson(res, 200, {
      ok: true,
      pending: false,
      done: true,
      account: auth.account,
      uid: auth.uid,
      expires: auth.expires,
    })
  }

  if (p === '/local/workbuddy/logout') {
    saveAuth({ access: '', refresh: '', expires: 0, refreshExpiresAt: 0, uid: '', domain: '', account: '', enterpriseId: '' })
    return sendJson(res, 200, statusValue())
  }

  if (p === '/local/workbuddy/v1/models') {
    return sendJson(res, 200, {
      object: 'list',
      data: MODELS.map(([id, name, context, output]) => ({
        id,
        object: 'model',
        name,
        owned_by: 'workbuddy',
        context_length: context,
        context_window: context,
        max_output_tokens: output,
      })),
    })
  }

  if (p === '/local/workbuddy/v1/chat/completions') {
    const body = await readBody(req)
    const auth = loadAuth()
    if (!auth.access) return sendJson(res, 401, { error: { message: 'WorkBuddy 未登录', type: 'unauthorized' } })
    const headers = {
      authorization: `Bearer ${auth.access}`,
      'x-user-id': auth.uid,
      'x-domain': auth.domain || 'copilot.tencent.com',
      'x-product': 'SaaS',
      'x-ide-type': 'WorkBuddy',
      'user-agent': `WorkBuddy/${APP} WorkBuddy/${APP} CLI/${CLI}`,
      'x-requested-with': 'XMLHttpRequest',
      'x-agent-intent': 'craft',
      'x-agent-purpose': 'conversation',
      'x-agent-type': 'main',
      'x-agent-runtime': 'local-agent',
      'x-ide-name': 'WorkBuddy',
      'x-ide-version': APP,
      accept: 'text/event-stream, application/json',
      'content-type': 'application/json',
    }
    const upstream = await fetch(`${ENDPOINT}/v2/chat/completions`, {
      method: 'POST',
      headers,
      body,
    })
    res.statusCode = upstream.status
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json')
    res.setHeader('cache-control', 'no-cache, no-transform')
    if (!upstream.body) {
      res.end(await upstream.text())
      return
    }
    for await (const chunk of upstream.body) {
      res.write(chunk)
    }
    res.end()
    return
  }

  sendJson(res, 404, { error: '未知的 WorkBuddy 接口' })
}

export function localWorkBuddyPlugin() {
  return {
    name: 'oc-workbench-local-workbuddy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/local/workbuddy')) {
          next()
          return
        }
        handle(req, res).catch((err) => {
          sendJson(res, 500, { error: err?.message || String(err) })
        })
      })
    },
  }
}
