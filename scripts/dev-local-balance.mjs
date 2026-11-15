// dev server 的 DeepSeek 余额接口，对齐 Rust 外壳的 `/local/balance`。
//
// 为什么要在 dev 里单独实现一份：`npm run dev` 时 `/local/*` 全部由 Vite 插件处理
// （不会转发给外壳），少了这份实现，顶栏胶囊在 dev 里恒为「余额 —」，还每 15 秒
// 发一次必失败的请求，界面验收根本看不出对错。
//
// 语义与 `shell/src/balance.rs` 保持一致：
//   GET  /local/balance          余额（4 秒防抖缓存，?refresh=1 绕过）
//   GET  /local/balance/status   掩码 + 来源 + magpie 有没有可读的 key
//   POST /local/balance/key      {"key":"sk-..."} 保存；{"action":"clear"} 清除
//   POST /local/balance/detect   从 magpie 读官方 key 并保存
//
// 只在 `npm run dev` 下生效，打包产物里不存在。

import { readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SETTING_KEY = 'deepseekApiKey'
const CACHE_TTL = 4000
const BALANCE_URL = 'https://api.deepseek.com/user/balance'

let cache = { body: '', at: 0 }

function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function sendJson(res, status, data) {
  const text = JSON.stringify(data)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

async function readBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw httpError(413, '请求体过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function settingsPath() {
  const base = process.env.LOCALAPPDATA
  return base ? path.join(base, 'oc-workbench', 'settings.json') : ''
}

function readSettings() {
  const file = settingsPath()
  if (!file) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function writeSettings(map) {
  const file = settingsPath()
  if (!file) throw httpError(500, '找不到 settings.json 的位置')
  writeFileSync(file, JSON.stringify(map, null, 2), 'utf8')
}

function maskKey(key) {
  const chars = [...String(key)]
  if (chars.length <= 10) return '•'.repeat(Math.max(4, chars.length))
  return `${chars.slice(0, 6).join('')}…${chars.slice(-4).join('')}`
}

function keyFromSettings() {
  const value = readSettings()[SETTING_KEY]
  const key = typeof value === 'string' ? value.trim() : ''
  return key || ''
}

function keyFromEnv() {
  return (process.env.DEEPSEEK_API_KEY || '').trim()
}

/** 读 magpie 里官方 deepseek 的 key（只在用户点「从 magpie 读取」时用）。 */
function keyFromMagpie() {
  const file = path.join(os.homedir(), '.config', 'magpie', 'providers.json')
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return ''
  }
  const list = Array.isArray(parsed.providers)
    ? parsed.providers
    : Object.values(parsed.providers || {})
  const hit = list.find((item) => item && item.id === 'deepseek')
  const key = hit && typeof hit.key === 'string' ? hit.key.trim() : ''
  return key || ''
}

function resolveKey() {
  const settings = keyFromSettings()
  if (settings) return { key: settings, source: 'settings' }
  const env = keyFromEnv()
  if (env) return { key: env, source: 'env' }
  return null
}

function statusValue() {
  const resolved = resolveKey()
  const magpie = keyFromMagpie()
  return {
    configured: Boolean(resolved),
    source: resolved ? resolved.source : 'none',
    masked: resolved ? maskKey(resolved.key) : '',
    hasMagpie: Boolean(magpie),
    magpieMasked: magpie ? maskKey(magpie) : '',
  }
}

function normalizeKey(raw) {
  const key = String(raw || '').trim()
  if (!key) throw httpError(400, '密钥不能为空')
  if (!key.startsWith('sk-')) throw httpError(400, 'DeepSeek 官方密钥以 sk- 开头')
  if ([...key].length < 20) throw httpError(400, '密钥长度不对（官方是 sk- 后 32 位十六进制）')
  if ([...key].length > 200) throw httpError(400, '密钥过长')
  return key
}

function withCached(body, cached) {
  try {
    return JSON.stringify({ ...JSON.parse(body), cached })
  } catch {
    return body
  }
}

function summarize(raw, source) {
  let value
  try {
    value = JSON.parse(raw)
  } catch (err) {
    throw new Error(`余额响应不是 JSON：${err.message}`)
  }
  const infos = Array.isArray(value.balance_infos) ? value.balance_infos : []
  const pick = infos.find((info) => info.currency === 'CNY') || infos[0]
  if (!pick) throw new Error('余额响应里没有 balance_infos（账号可能还没开通）')
  const field = (name) => {
    const raw2 = pick[name]
    if (typeof raw2 === 'string') return raw2
    if (typeof raw2 === 'number') return raw2.toFixed(2)
    return '0.00'
  }
  return JSON.stringify({
    ok: true,
    source,
    currency: typeof pick.currency === 'string' ? pick.currency : 'CNY',
    total: field('total_balance'),
    granted: field('granted_balance'),
    toppedUp: field('topped_up_balance'),
    available: value.is_available === true,
    fetchedAt: Math.floor(Date.now() / 1000),
  })
}

async function requestBalance(key) {
  const res = await fetch(BALANCE_URL, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
  })
  const text = await res.text()
  if (res.status === 401) {
    throw new Error('DeepSeek 返回 401：密钥无效或已失效（点余额胶囊重新填一个）')
  }
  if (!res.ok) throw new Error(`余额接口返回 HTTP ${res.status}`)
  return text
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')

  if (url.pathname === '/local/balance/status') {
    if (req.method !== 'GET') throw httpError(405, '状态只支持 GET')
    return sendJson(res, 200, statusValue())
  }

  if (url.pathname === '/local/balance/key') {
    if (req.method !== 'POST') throw httpError(405, '保存密钥只支持 POST')
    const text = (await readBody(req, 8 * 1024)).toString('utf8').trim()
    let body = {}
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      throw httpError(400, '请求体不是 JSON')
    }
    if (body.action === 'clear') {
      const settings = readSettings()
      delete settings[SETTING_KEY]
      writeSettings(settings)
      cache = { body: '', at: 0 }
      return sendJson(res, 200, statusValue())
    }
    const key = normalizeKey(body.key)
    const settings = readSettings()
    settings[SETTING_KEY] = key
    writeSettings(settings)
    cache = { body: '', at: 0 }
    return sendJson(res, 200, statusValue())
  }

  if (url.pathname === '/local/balance/detect') {
    if (req.method !== 'POST') throw httpError(405, '自动读取只支持 POST')
    await readBody(req, 8 * 1024)
    const key = keyFromMagpie()
    if (!key) throw httpError(404, 'magpie 里没有找到 DeepSeek 官方密钥')
    const settings = readSettings()
    settings[SETTING_KEY] = key
    writeSettings(settings)
    cache = { body: '', at: 0 }
    return sendJson(res, 200, statusValue())
  }

  if (url.pathname !== '/local/balance') throw httpError(404, '未知的余额接口')
  if (req.method !== 'GET') throw httpError(405, '余额只支持 GET')

  const force = url.search.includes('refresh=1')
  const now = Date.now()
  if (!force && cache.body && now - cache.at < CACHE_TTL) {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(withCached(cache.body, true))
    return
  }

  const resolved = resolveKey()
  if (!resolved) {
    return sendJson(res, 200, {
      ok: false,
      error: '没有找到 DeepSeek 官方密钥：点余额胶囊填入 sk，或设置环境变量 DEEPSEEK_API_KEY',
    })
  }
  try {
    const raw = await requestBalance(resolved.key)
    const body = summarize(raw, resolved.source)
    cache = { body, at: Date.now() }
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(withCached(body, false))
  } catch (err) {
    sendJson(res, 200, { ok: false, error: err.message || String(err) })
  }
}

export function localBalancePlugin() {
  return {
    name: 'oc-workbench-local-balance',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/local/balance')) {
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
