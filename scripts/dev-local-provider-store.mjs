// dev 的 provider 配置读写（对齐 shell/src/provider_store.rs + provider_io.rs + provider_upsert.rs）。
// 拆成独立模块：主文件只负责路由。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { httpError } from './dev-local-provider-util.mjs'

/** 备份最多保留几份。 */
const BACKUP_KEEP = 10
let tmpSeq = 0

export function configPath() {
  const home = process.env.USERPROFILE || os.homedir()
  return path.join(home, '.config', 'opencode', 'opencode.json')
}

export function readConfig() {
  const file = configPath()
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    // 只有「文件不存在」才算空配置。其它读失败（权限、被独占）必须拒写，
    // 否则保存会把整份配置覆盖成只剩 provider（Rust 侧踩过这个 🔴）。
    if (err.code === 'ENOENT') return { value: {}, error: '' }
    return { value: null, error: `读不了 opencode.json（${err.message}）` }
  }
  if (!text.trim()) return { value: {}, error: '' }
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { value: null, error: 'opencode.json 顶层不是对象' }
    }
    return { value, error: '' }
  } catch (err) {
    return { value: null, error: `opencode.json 不是合法 JSON（${err.message}）` }
  }
}

export function maskKey(key) {
  const text = String(key ?? '').trim()
  if (!text) return ''
  if (text.length < 12) return '*'.repeat(text.length)
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}

function providerView(id, value) {
  const options = (value && value.options) || {}
  const models = (value && value.models) || {}
  const keys = Object.keys(models)
  return {
    id,
    name: value?.name || id,
    npm: value?.npm || '',
    baseURL: options.baseURL || '',
    keyMasked: maskKey(options.apiKey),
    hasKey: Boolean(String(options.apiKey ?? '').trim()),
    modelCount: keys.length,
    models: keys.map((key) => ({
      id: key,
      name: models[key]?.name || key,
      context: Number(models[key]?.limit?.context) || 0,
      output: Number(models[key]?.limit?.output) || 0,
    })),
  }
}

export function readStatus() {
  const file = configPath()
  const { value, error } = readConfig()
  const providers = Object.entries(value?.provider || {})
    .map(([id, entry]) => providerView(id, entry))
    .sort((left, right) => left.id.localeCompare(right.id))
  return {
    ok: true,
    path: file,
    exists: existsSync(file),
    error,
    // 默认模型（opencode.json 顶层 model）：账号同步时要一起带过去
    model: typeof value?.model === 'string' ? value.model : '',
    providers,
  }
}

/** 顶层键快照：写前后除 provider 外必须一字未动。 */
function topLevelKeys(value) {
  return Object.entries(value || {})
    .filter(([key]) => key !== 'provider')
    .map(([key, item]) => [key, Array.isArray(item) ? 'array' : item === null ? 'null' : typeof item])
    .sort((left, right) => left[0].localeCompare(right[0]))
}

/**
 * 写回自检口径：除 provider 外的顶层键必须一字未动。
 *
 * 唯一例外是顶层 `model`（默认模型）：账号同步和面板「默认模型」本来就要写它，
 * 而新电脑上这个键通常不存在 —— 一律拒绝会让首次设默认模型永远 500；
 * `"model": null` 这类「键在但不是字符串」的旧值也要能纠正（读取侧把 null 当未设置）。
 * 但「没碰它」必须放行：只保存 provider 时 model 根本没改，哪怕原值是 null/object 也不能拦，
 * 否则保存/删除/账号同步整条主流程会被一条没动的旧值卡死。
 * 规则：类型原样 → 放行；真要改 → 必须是字符串；删掉 → 拦；其余顶层键仍须一字未动。
 */
function guardAllows(before, after) {
  // 比较前统一排序：调用方即使传了未排序的 map 迭代结果，也不会被误判成「改了配置」。
  const rest = (keys) =>
    keys
      .filter(([key]) => key !== 'model')
      .slice()
      .sort((left, right) => left[0].localeCompare(right[0]))
  if (JSON.stringify(rest(before)) !== JSON.stringify(rest(after))) return false
  const modelType = (keys) => {
    const hit = keys.find(([key]) => key === 'model')
    return hit ? hit[1] : null
  }
  const old = modelType(before)
  const next = modelType(after)
  // after 没有 model：除非 before 也没有，否则算「删了它」→ 拦
  if (next === null) return old === null
  // 类型没变 → 没碰它（哪怕原值是 null/object 这种坏形态）
  if (old === next) return true
  // 要改 → 只能是字符串（新建，或从 null/number/object 纠正过来）
  return next === 'string'
}

function rotateBackups(file) {
  const dir = path.dirname(file)
  const base = path.basename(file)
  const prefix = `${base}.bak-`
  const found = readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    // 按修改时间排：Rust 与 dev 的备份命名不同，按名字排会删错对象
    .map((name) => {
      const full = path.join(dir, name)
      let mtime = 0
      try {
        mtime = statSync(full).mtimeMs
      } catch {
        // 读不到就按 0 排到最旧
      }
      return { full, mtime }
    })
    .sort((left, right) => left.mtime - right.mtime)
    .map((item) => item.full)
  // found 里已经是完整路径，别再 join 一次（会拼出 dir/F:/... 这种不存在的路径，
  // 表现为「备份一直在涨、轮转静默失效」——实测堆到 42 份才发现）。
  for (const full of found.slice(0, Math.max(0, found.length - BACKUP_KEEP))) {
    try {
      rmSync(full)
    } catch {
      // 轮转失败不影响主流程
    }
  }
}

/**
 * 备份 + 自检 + 原子写。`mutate` 拿到可写对象，改它，返回错误就放弃。
 */
export function saveConfig(mutate) {
  const file = configPath()
  const { value, error } = readConfig()
  if (error) throw httpError(409, `${error}；先修好 opencode.json 再保存，避免覆盖你手改的内容`)

  const before = topLevelKeys(value)
  // 深拷贝：浅拷贝时 mutate 改到的 provider 对象和 `value` 共用同一份，
  // 一旦以后有人把自检挪到 mutate 之后就会读到改过的值（隐性 bug 温床）。
  const next = structuredClone(value)
  mutate(next)
  if (!guardAllows(before, topLevelKeys(next))) {
    throw httpError(500, '自检失败：写回会改动 provider 以外的配置，已放弃保存')
  }

  mkdirSync(path.dirname(file), { recursive: true })
  if (existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(file, `${file}.bak-${stamp}`)
    rotateBackups(file)
  }
  const tmp = path.join(path.dirname(file), `.opencode.json.tmp-${process.pid}-${++tmpSeq}`)
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return next
}

export function upsertProvider(config, { id, name, baseURL, apiKey, models }) {
  if (!config.provider || typeof config.provider !== 'object' || Array.isArray(config.provider)) {
    if (config.provider !== undefined) throw httpError(400, '配置里的 provider 不是对象，已放弃写入')
    config.provider = {}
  }
  const raw = config.provider[id]
  const previous = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const previousModels = previous.models || {}
  // options 里还可能有 headers / timeout 这类用户手调的字段，只覆盖地址与密钥。
  const previousOptions =
    previous.options && typeof previous.options === 'object' && !Array.isArray(previous.options)
      ? previous.options
      : {}
  const nextModels = {}
  for (const raw of models || []) {
    // 兼容「纯字符串」与「{id,name,context,output}」两种写法
    const item = typeof raw === 'string' ? { id: raw } : raw
    const key = String(item?.id ?? '').trim()
    if (!key) continue
    const kept = previousModels[key] && typeof previousModels[key] === 'object' ? previousModels[key] : {}
    const name = typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : kept.name || key
    const context = Number(item?.context) || 0
    const output = Number(item?.output) || 0
    const next = { ...kept, name }
    // 上下文以界面/上游给的为准；没给就保留旧值（没有就不写 limit）
    if (context > 0) next.limit = output > 0 ? { context, output } : { context }
    nextModels[key] = next
  }
  // 以旧条目为底：env / blacklist / whitelist / doc / 自定义 npm 都要留着，
  // 只覆盖 name / options / models 三个键。
  config.provider[id] = {
    ...previous,
    name: name || id,
    npm: previous.npm || '@ai-sdk/openai-compatible',
    options: { ...previousOptions, baseURL, apiKey },
    models: nextModels,
  }
}

export function removeProvider(config, id) {
  if (!config.provider || typeof config.provider !== 'object') {
    throw httpError(400, '配置里没有 provider，没什么可删')
  }
  if (!(id in config.provider)) throw httpError(400, `没有找到 provider ${id}`)
  delete config.provider[id]
}

/** 前端把掩码传回来（用户没改 key）时，从磁盘读回真 key。 */
export function keyFromDisk(masked, id) {
  // 只认同一个 id。以前没有 id 时会按掩码遍历所有 provider，
  // 那等于「知道掩码就能取走任意 provider 的真 key」。
  if (!id) return ''
  const { value } = readConfig()
  const key = value?.provider?.[id]?.options?.apiKey || ''
  if (!key) return ''
  return maskKey(key) === String(masked).trim() ? key : ''
}
