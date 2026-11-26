/**
 * dev 环境下的码栖通道接口（发布版由 Rust 外壳提供，字段逐字一致）。
 *
 * 这里只补「状态 / 导入 / 退出 / 模型列表」四件：开发时能点开卡片、能把
 * provider 填进表单。真正的聊天转发要读 DPAPI 密钥并做协议转换，由 exe 里的
 * `maxi_proxy` 负责，dev 里返回 501 并给出提示——避免维护两份转发逻辑。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

function dir() {
  return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'oc-workbench')
}

function authPath() {
  return path.join(dir(), 'maxi.json')
}

function loadAuth() {
  try {
    const v = JSON.parse(readFileSync(authPath(), 'utf8'))
    return {
      host: String(v.host || ''),
      loginToken: String(v.loginToken || ''),
      deviceId: String(v.deviceId || ''),
      deviceNo: String(v.deviceNo || ''),
      deviceName: String(v.deviceName || ''),
      accessToken: String(v.accessToken || ''),
      accessExpires: Number(v.accessExpires || 0),
      model: String(v.model || ''),
    }
  } catch {
    return {
      host: '',
      loginToken: '',
      deviceId: '',
      deviceNo: '',
      deviceName: '',
      accessToken: '',
      accessExpires: 0,
      model: '',
    }
  }
}

function saveAuth(auth) {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(authPath(), JSON.stringify(auth), 'utf8')
}

function localKey() {
  const p = path.join(dir(), 'settings.json')
  let map = {}
  try {
    map = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    map = {}
  }
  if (typeof map.maxiKey === 'string' && map.maxiKey.trim()) return map.maxiKey
  const key = 'maxi-' + [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('')
  map.maxiKey = key
  mkdirSync(dir(), { recursive: true })
  writeFileSync(p, JSON.stringify(map), 'utf8')
  return key
}

function available() {
  const base = path.join(process.env.APPDATA || '', 'Maxi')
  try {
    readFileSync(path.join(base, 'remote-connection.json'))
    readFileSync(path.join(base, 'Local State'))
    return true
  } catch {
    return false
  }
}

function statusValue() {
  const auth = loadAuth()
  return {
    ok: true,
    configured: Boolean(auth.host && auth.loginToken && auth.deviceId),
    available: available(),
    host: auth.host,
    deviceId: auth.deviceId,
    deviceName: auth.deviceName,
    model: auth.model || 'gpt-6.2-sol',
    expires: auth.accessExpires,
    path: '/local/maxi/v1',
    apiKey: localKey(),
  }
}

/** 用 pwsh 解 DPAPI + AES-GCM（Node 没有现成实现）。 */
async function readFromClient() {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$base = Join-Path $env:APPDATA 'Maxi'
$ls = Get-Content (Join-Path $base 'Local State') -Raw | ConvertFrom-Json
$enc = [Convert]::FromBase64String($ls.os_crypt.encrypted_key)
$key = [System.Security.Cryptography.ProtectedData]::Unprotect($enc[5..($enc.Length-1)], $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
$rc = Get-Content (Join-Path $base 'remote-connection.json') -Raw | ConvertFrom-Json
$d = [Convert]::FromBase64String($rc.encryptedToken)
$aes = [System.Security.Cryptography.AesGcm]::new($key, 16)
$plain = New-Object byte[] ($d.Length - 31)
$aes.Decrypt($d[3..14], $d[15..($d.Length-17)], $d[($d.Length-16)..($d.Length-1)], $plain)
@{ host = $rc.serverHost; deviceId = $rc.deviceId; deviceNo = $rc.deviceNo; deviceName = $rc.deviceName; loginToken = [Text.Encoding]::UTF8.GetString($plain) } | ConvertTo-Json -Compress
`
  const { stdout } = await execFileAsync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 30000,
    windowsHide: true,
  })
  return JSON.parse(stdout.trim())
}

async function exchangeToken(auth) {
  const res = await fetch(`${auth.host.replace(/\/+$/, '')}/app/model/default/token`, {
    method: 'POST',
    headers: { authorization: auth.loginToken, 'x-device-id': auth.deviceId },
    signal: AbortSignal.timeout(20000),
  })
  const json = await res.json()
  const data = json?.data
  if (!data?.token) throw new Error(json?.msg || '换取访问令牌失败')
  auth.accessToken = data.token
  auth.accessExpires = Date.now() + (Number(data.expiresInSeconds) || 1800) * 1000
  if (data.model) auth.model = data.model
  return auth
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(body)
}

export function localMaxiPlugin() {
  return {
    name: 'oc-local-maxi',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost')
        const p = url.pathname
        if (p !== '/local/maxi' && !p.startsWith('/local/maxi/')) return next()
        try {
          if (p === '/local/maxi/status') return sendJson(res, 200, statusValue())
          if (p === '/local/maxi/import') {
            try {
              const raw = await readFromClient()
              const auth = {
                host: String(raw.host || '').startsWith('http') ? String(raw.host) : `https://${raw.host}`,
                loginToken: String(raw.loginToken || ''),
                deviceId: String(raw.deviceId || ''),
                deviceNo: String(raw.deviceNo || ''),
                deviceName: String(raw.deviceName || ''),
                accessToken: '',
                accessExpires: 0,
                model: '',
              }
              try {
                await exchangeToken(auth)
              } catch {
                // 换令牌失败不影响导入本身
              }
              saveAuth(auth)
              return sendJson(res, 200, { ok: true, model: auth.model, status: statusValue() })
            } catch (err) {
              return sendJson(res, 200, { ok: false, error: String(err?.message || err) })
            }
          }
          if (p === '/local/maxi/logout') {
            saveAuth({ host: '', loginToken: '', deviceId: '', deviceNo: '', deviceName: '', accessToken: '', accessExpires: 0, model: '' })
            return sendJson(res, 200, statusValue())
          }
          if (p === '/local/maxi/bind/create' || p === '/local/maxi/bind/poll') {
            // 二维码渲染和上游绑定都在 Rust 外壳里，dev 只给一句明确提示。
            return sendJson(res, 200, { ok: false, error: 'dev 模式不支持扫码绑定：请用 npm run build:exe 出的 exe' })
          }
          if (p === '/local/maxi/v1/models') {
            const auth = loadAuth()
            return sendJson(res, 200, {
              object: 'list',
              data: [{ id: auth.model || 'gpt-6.2-sol', object: 'model', owned_by: 'maxi' }],
            })
          }
          if (p === '/local/maxi/v1/chat/completions') {
            await readBody(req)
            return sendJson(res, 501, {
              error: {
                message: 'dev 模式不转发模型请求：请用 npm run build:exe 出的 exe 验证（转发在 Rust 外壳里）',
                type: 'not_implemented',
              },
            })
          }
          return sendJson(res, 404, { error: '未知的码栖 dev 接口' })
        } catch (err) {
          return sendJson(res, 500, { error: String(err?.message || err) })
        }
      })
    },
  }
}
