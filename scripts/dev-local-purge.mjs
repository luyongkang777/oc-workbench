// Vite dev server 的破甲开关中间件：接口与 Rust 外壳的 `/local/purge/*` 对齐。
//
// 生产走 `shell/src/purge.rs`（读 %USERPROFILE%\.config\opencode\purge），dev 没有
// 外壳，这里用 Node 实现同一套语义，字段名逐字一致——前端只认一套形状。
//
// 只读写插件 config.json 里的 `enabled`：提示词、perModel、生成参数继续由插件
// 和用户手改文件维护，这个接口不提供通用文件写入。
//
// 只在 `npm run dev` 生效，打包产物不包含它。

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const BODY_LIMIT = 64 * 1024

export function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/** 与 Rust 侧 `data_dir()` / `plugin_dir()` 同一套路径。 */
export function purgePaths(home = homedir()) {
  const opencode = path.join(home, '.config', 'opencode')
  return {
    dataDir: path.join(opencode, 'purge'),
    pluginDir: path.join(opencode, 'plugins', 'purge'),
  }
}

/** 读 JSON：空文件当 {}；坏 JSON 记错误，不静默覆盖。 */
async function readJson(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { value: null, error: null, exists: false }
  }
  if (!text.trim()) return { value: {}, error: null, exists: true }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, error: 'config.json 顶层不是对象', exists: true }
    }
    return { value: parsed, error: null, exists: true }
  } catch (err) {
    return { value: null, error: `config.json 不是合法 JSON（${err.message}）`, exists: true }
  }
}

async function fileInfo(file) {
  try {
    const info = await stat(file)
    return info.isFile() ? { exists: true, bytes: info.size } : { exists: false, bytes: 0 }
  } catch {
    return { exists: false, bytes: 0 }
  }
}

async function mtimeMs(file) {
  try {
    return (await stat(file)).mtimeMs
  } catch {
    return null
  }
}

/** 与插件 `normalize()` 一致：缺省算开，只有显式 false / "false" 才算关。 */
function enabledOf(config) {
  if (!config || config.enabled === undefined) return true
  return config.enabled !== false && config.enabled !== 'false'
}

/** 与 `core.mts` 的 `promptPathFor` 对齐：绝对路径原样，相对路径先插件目录后数据目录。 */
async function resolvePrompt(dataDir, pluginDir, raw) {
  if (path.isAbsolute(raw)) return raw
  const bundled = path.join(pluginDir, raw)
  const bundledInfo = await fileInfo(bundled)
  return bundledInfo.exists ? bundled : path.join(dataDir, raw)
}

export async function readPurgeStatus(home = homedir()) {
  const { dataDir, pluginDir } = purgePaths(home)
  const configPath = path.join(dataDir, 'config.json')
  const { value, error, exists } = await readJson(configPath)
  const config = value || {}

  const promptFile =
    typeof config.promptFile === 'string' && config.promptFile.trim()
      ? config.promptFile
      : 'prompt-inject.md'
  const promptPath = path.join(dataDir, promptFile)
  const promptInfo = await fileInfo(promptPath)

  const models = []
  if (config.perModel && typeof config.perModel === 'object') {
    for (const [key, file] of Object.entries(config.perModel)) {
      if (typeof file !== 'string' || !file.trim()) continue
      const resolved = await resolvePrompt(dataDir, pluginDir, file)
      const info = await fileInfo(resolved)
      models.push({ key, file, path: resolved, exists: info.exists, bytes: info.bytes })
    }
  }
  models.sort((left, right) => String(left.key).localeCompare(String(right.key)))

  const state = await readJson(path.join(dataDir, 'state.json'))

  // 关键词表：带文件是否存在。配置里没有 keywordMap 时返回 null
  // （插件会自动套用内置五项默认）；显式 false 时是空数组（全关）。
  let keywords = null
  if (config.keywordMap !== undefined && config.keywordMap !== null) {
    keywords = []
    if (config.keywordMap && typeof config.keywordMap === 'object' && !Array.isArray(config.keywordMap)) {
      for (const [key, file] of Object.entries(config.keywordMap)) {
        if (typeof file !== 'string' || !file.trim()) continue
        const resolved = await resolvePrompt(dataDir, pluginDir, file)
        const info = await fileInfo(resolved)
        keywords.push({ keyword: key.toLowerCase(), file, path: resolved, exists: info.exists, bytes: info.bytes })
      }
      keywords.sort((left, right) => left.keyword.localeCompare(right.keyword))
    }
  }

  return {
    ok: true,
    dataDir,
    pluginDir,
    pluginInstalled: (await fileInfo(path.join(pluginDir, 'index.ts'))).exists,
    configPath,
    configExists: exists,
    configError: error || '',
    configMtimeMs: await mtimeMs(configPath),
    enabled: enabledOf(config),
    injectDefault:
      config.injectDefault === undefined
        ? true
        : config.injectDefault !== false && config.injectDefault !== 'false',
    promptFile,
    promptPath,
    promptExists: promptInfo.exists,
    promptBytes: promptInfo.bytes,
    perModel: models,
    keywords,
    temperature: config.temperature ?? null,
    maxTokens: config.maxTokens ?? null,
    toolsDeny: Array.isArray(config.tools?.deny) ? config.tools.deny : [],
    verbose: config.verbose === true || config.verbose === 'true',
    state: state.exists ? state.value : null,
  }
}

/** 只改 enabled，其余字段按磁盘原文保留；坏 JSON 直接 409，不覆盖。 */
export async function setPurgeEnabled(enabled, home = homedir()) {
  const { dataDir } = purgePaths(home)
  const configPath = path.join(dataDir, 'config.json')
  const { value, error } = await readJson(configPath)
  if (error) throw httpError(409, `${error}；先修好 config.json 再切换，避免覆盖手改内容`)

  const next = { ...(value || {}), enabled: Boolean(enabled) }
  await mkdir(dataDir, { recursive: true })
  const tmp = path.join(dataDir, `.config.json.tmp-${process.pid}`)
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  try {
    await rename(tmp, configPath)
  } catch (err) {
    await rm(tmp, { force: true })
    throw httpError(500, `写配置失败：${err.message}`)
  }
  return readPurgeStatus(home)
}

async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > BODY_LIMIT) throw httpError(413, '请求体过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

export async function handlePurge(req, res) {
  const action = String(req.url || '').split('?')[0].split('/').pop()

  if (action === 'status') {
    if (req.method !== 'GET') throw httpError(405, '状态只支持 GET')
    return sendJson(res, 200, await readPurgeStatus())
  }

  if (action === 'enabled') {
    if (req.method !== 'POST') throw httpError(405, '开关只支持 POST')
    const text = await readBody(req)
    let parsed
    try {
      parsed = JSON.parse(text || '{}')
    } catch (err) {
      throw httpError(400, `请求体不是 JSON：${err.message}`)
    }
    if (typeof parsed?.enabled !== 'boolean') throw httpError(400, '缺少 enabled（true / false）')
    return sendJson(res, 200, await setPurgeEnabled(parsed.enabled))
  }

  throw httpError(404, '未知的破甲接口')
}

/** 只拦 `/local/purge` 前缀；必须排在 `localFsPlugin` 前面。 */
export function localPurgePlugin() {
  return {
    name: 'oc-workbench-local-purge',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || ''
        if (url !== '/local/purge' && !url.startsWith('/local/purge/')) {
          next()
          return
        }
        handlePurge(req, res).catch((err) => {
          const status = err.status || 500
          sendJson(res, status, { error: err.message || '破甲接口失败', status })
        })
      })
    },
  }
}
