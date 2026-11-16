// Vite dev server 的强制规则接口，对应 Rust 外壳的 `/local/rules/*`。
//
// 规则是**条目**（单行 / 标题+内容两行），存 JSON：
//   全局 ~/.config/opencode/rules/workbench-global.json
//   目录 <项目>/.opencode/rules.json
// 老的整块 .md 会被解析成条目（只读兼容），第一次保存时改名留档。
//
// 判定（注入 / 拦截）在 opencode 插件里，不在这里 —— dev 与生产口径一致。
// 只在 `npm run dev` 生效，构建产物里不包含。

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** 与 core.mts / Rust 一致。 */
const MAX_RULE_BYTES = 64 * 1024
const BODY_LIMIT = MAX_RULE_BYTES + 8 * 1024
const MAX_ITEMS = 500

export function rulesPaths(home = homedir()) {
  const opencode = path.join(home, '.config', 'opencode')
  return {
    dataDir: path.join(opencode, 'rules'),
    pluginDir: path.join(opencode, 'plugins', 'rules'),
    globalFile: path.join(opencode, 'rules', 'workbench-global.json'),
    globalLegacy: path.join(opencode, 'rules', 'workbench-global.md'),
  }
}

export function localRuleFile(directory) {
  return path.join(directory, '.opencode', 'rules.json')
}

export function localLegacyFile(directory) {
  return path.join(directory, '.opencode', 'rules.md')
}

/** 条目归一化：内容为空丢掉，标题可空。 */
export function normalizeItems(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const text = String(entry.text ?? '').trim()
    if (!text) continue
    const title = String(entry.title ?? '').trim()
    out.push(title ? { title, text } : { title: '', text })
  }
  return out
}

/**
 * 老格式 markdown → 条目（与 core.mts / Rust 同口径）：
 * `#` 标题 + 紧跟的非空行 = 标题/内容两行条目；其余非空行 = 单行条目。
 */
export function parseLegacyMarkdown(raw) {
  const lines = String(raw ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)
  const items = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const heading = /^#{1,6}\s*(.+)$/.exec(line)
    if (heading) {
      const title = heading[1].trim()
      let body = ''
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim()
        if (!next) continue
        if (/^#{1,6}\s*/.test(next)) break
        body = next.replace(/^[-*]\s+/, '')
        i = j
        break
      }
      items.push(body ? { title, text: body } : { title: '', text: title })
      continue
    }
    items.push({ title: '', text: line.replace(/^[-*]\s+/, '') })
  }
  return normalizeItems(items)
}

async function meta(file) {
  try {
    const info = await stat(file)
    return info.isFile()
      ? { exists: true, bytes: info.size, mtimeMs: info.mtimeMs }
      : { exists: false, bytes: 0, mtimeMs: null }
  } catch {
    return { exists: false, bytes: 0, mtimeMs: null }
  }
}

async function readRule(scope, file, legacy) {
  const info = await meta(file)
  if (info.exists) {
    try {
      const text = await readFile(file, 'utf8')
      const parsed = JSON.parse(text || '{"items":[]}')
      return {
        scope,
        path: file,
        ...info,
        error: null,
        items: normalizeItems(parsed?.items),
        migratedFrom: '',
      }
    } catch (err) {
      return {
        scope,
        path: file,
        ...info,
        error: `不是合法 JSON：${String(err?.message || err)}`,
        items: [],
        migratedFrom: '',
      }
    }
  }
  if (legacy) {
    const old = await meta(legacy)
    if (old.exists) {
      try {
        const text = await readFile(legacy, 'utf8')
        if (text.trim()) {
          return {
            scope,
            path: file,
            ...old,
            error: null,
            items: parseLegacyMarkdown(text),
            migratedFrom: legacy,
          }
        }
      } catch (err) {
        return { scope, path: file, ...old, error: String(err?.message || err), items: [], migratedFrom: '' }
      }
    }
  }
  return { scope, path: file, ...info, error: null, items: [], migratedFrom: '' }
}

export async function readRulesStatus(directory = '', home = homedir()) {
  const { pluginDir, globalFile, globalLegacy, dataDir } = rulesPaths(home)
  const global = await readRule('global', globalFile, globalLegacy)
  const local = directory
    ? await readRule('local', localRuleFile(directory), localLegacyFile(directory))
    : { scope: 'local', path: '', exists: false, bytes: 0, mtimeMs: null, error: null, items: [], migratedFrom: '' }

  const total = global.items.length + local.items.length
  const readErrors = [global, local].filter((item) => item.error).length
  const pluginInfo = await meta(path.join(pluginDir, 'index.ts'))

  return {
    ok: true,
    directory,
    global,
    local,
    active: total > 0,
    totalItems: total,
    readErrors,
    pluginInstalled: pluginInfo.exists,
    pluginDir,
    dataDir,
    maxBytes: MAX_RULE_BYTES,
    maxItems: MAX_ITEMS,
  }
}

export async function saveRule(scope, directory, items, home = homedir()) {
  if (!Array.isArray(items)) {
    const err = new Error('缺少 items 数组（清空请显式传 []）')
    err.status = 400
    throw err
  }
  if (scope !== 'global' && scope !== 'local') {
    const err = new Error('scope 只能是 global 或 local')
    err.status = 400
    throw err
  }
  let file
  let legacy = null
  if (scope === 'global') {
    const paths = rulesPaths(home)
    file = paths.globalFile
    legacy = paths.globalLegacy
  } else {
    if (!directory) {
      const err = new Error('缺少 directory（当前项目目录）')
      err.status = 400
      throw err
    }
    if (!path.isAbsolute(directory)) {
      const err = new Error('directory 必须是绝对路径')
      err.status = 400
      throw err
    }
    file = localRuleFile(directory)
    legacy = localLegacyFile(directory)
  }

  const clean = normalizeItems(items)
  if (clean.length > MAX_ITEMS) {
    const err = new Error(`条目数超过 ${MAX_ITEMS} 条上限`)
    err.status = 413
    throw err
  }
  const payload = `${JSON.stringify({ version: 1, items: clean }, null, 1)}\n`
  if (Buffer.byteLength(payload, 'utf8') > MAX_RULE_BYTES) {
    const err = new Error('规则体积超过上限')
    err.status = 413
    throw err
  }

  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, file)

  // 迁移：老 md 已并入 JSON，改名留档
  if (legacy) {
    const old = await meta(legacy)
    if (old.exists && old.bytes > 0) {
      await rename(legacy, `${legacy}.migrated-${Date.now()}`).catch(() => {})
    }
  }
  return readRulesStatus(directory, home)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        const err = new Error('请求体过大')
        err.status = 413
        reject(err)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/** Vite 插件：拦 `/local/rules/*`，其余放行。 */
export function localRulesPlugin(home) {
  return {
    name: 'oc-workbench-local-rules',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const raw = req.url ?? ''
        const pathname = raw.split('?')[0]
        if (!pathname.startsWith('/local/rules/')) return next()

        try {
          const query = new URLSearchParams(raw.split('?')[1] ?? '')
          if (pathname === '/local/rules/status' && req.method === 'GET') {
            return send(res, 200, await readRulesStatus(query.get('directory') ?? '', home))
          }
          if (pathname === '/local/rules/save' && req.method === 'POST') {
            const parsed = JSON.parse((await readBody(req)) || '{}')
            return send(
              res,
              200,
              await saveRule(parsed.scope, String(parsed.directory ?? '').trim(), parsed.items, home),
            )
          }
          return send(res, 404, { error: '未知的规则接口' })
        } catch (err) {
          return send(res, err?.status ?? 500, { error: String(err?.message || err) })
        }
      })
    },
  }
}
