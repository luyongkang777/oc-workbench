// 用量日志与 opencode 会话库的读取与定价（dev 版）。
// 口径与 `shell/src/usage_record.rs` / `usage_session.rs` 一致。

import { existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PRICE_FILE = path.join(HERE, '..', 'shell', 'src', 'usage_prices.json')

let priceTable = null

function prices() {
  if (priceTable) return priceTable
  priceTable = new Map()
  try {
    const raw = JSON.parse(readFileSync(PRICE_FILE, 'utf8'))
    for (const [id, parts] of Object.entries(raw.models ?? {})) {
      // 0 价条目（免费额度/未定价）与 Rust 侧一样当作「认不出」
      if ((Number(parts[0]) || 0) + (Number(parts[1]) || 0) <= 0) continue
      priceTable.set(id.toLowerCase(), {
        input: Number(parts[0]) || 0,
        output: Number(parts[1]) || 0,
        cacheRead: Number(parts[2]) || 0,
        cacheWrite: Number(parts[3]) || 0,
      })
    }
  } catch {
    // 没有价格表就全部计为未计价，费用显示 $0
  }
  return priceTable
}

function variants(model) {
  const lower = String(model ?? '').trim().toLowerCase()
  if (!lower) return []
  const out = [lower]
  if (lower.includes('@')) out.push(lower.split('@')[0])
  if (lower.includes(':')) out.push(lower.split(':')[0])
  const dateStripped = lower.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '')
  if (dateStripped !== lower) out.push(dateStripped)
  return out
}

export function lookupPrice(model) {
  const table = prices()
  for (const candidate of variants(model)) {
    const price = table.get(candidate)
    if (price) return price
  }
  const tail = String(model ?? '').split('/').pop() ?? ''
  for (const candidate of variants(tail)) {
    const price = table.get(candidate)
    if (price) return price
  }
  return null
}

function costOf(price, input, output, cacheRead, cacheWrite) {
  if (!price) return 0
  return (
    (input * price.input +
      output * price.output +
      cacheRead * price.cacheRead +
      cacheWrite * price.cacheWrite) /
    1_000_000
  )
}

export function usageLogPath() {
  if (process.env.OCW_USAGE_LOG) return process.env.OCW_USAGE_LOG
  const home = process.env.USERPROFILE || os.homedir()
  return path.join(home, '.config', 'magpie', 'usage.jsonl')
}

let cache = null

/** 读网关日志（按 size + mtimeMs 缓存；文件追加后自动重读）。 */
export function loadRecords(file) {
  const stat = statSync(file)
  if (cache && cache.file === file && cache.size === stat.size && cache.mtimeMs === stat.mtimeMs) {
    return cache.records
  }
  const text = readFileSync(file, 'utf8')
  const records = []
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const stamp = typeof row.t === 'string' ? row.t : ''
    if (stamp.length < 19) continue
    // magpie 自检（探测供应商/列模型/探测 API）不算用户请求，与 magpie 用量页一致
    if (row.source === 'probe') continue
    if (['provider_test', 'model_list', 'api_detect'].includes(row.kind)) continue
    const input = Number(row.in) || 0
    const output = Number(row.out) || 0
    const cacheRead = Number(row.cache_read) || 0
    const cacheWrite = Number(row.cache_write) || 0
    const model = typeof row.served === 'string' && row.served ? row.served : String(row.model ?? '')
    // served 可能是别名：依次试 model 与 req，最后才判未计价
    const price = lookupPrice(model) ?? lookupPrice(row.model) ?? lookupPrice(row.req)
    records.push({
      day: stamp.slice(0, 10),
      hour: stamp.slice(11, 13),
      agent: String(row.agent ?? ''),
      provider: String(row.provider ?? ''),
      model,
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning: Number(row.reasoning) || 0,
      status: Number(row.status) || 0,
      tries: Number(row.tries) || 1,
      cost: costOf(price, input, output, cacheRead, cacheWrite),
      priced: Boolean(price),
    })
  }
  cache = { file, size: stat.size, mtimeMs: stat.mtimeMs, records }
  return records
}

export function opencodeDbPath() {
  if (process.env.OCW_OPENCODE_DB) return process.env.OCW_OPENCODE_DB
  const home = process.env.USERPROFILE || os.homedir()
  return path.join(home, '.local', 'share', 'opencode', 'opencode.db')
}

/** 每次重读「上次位置往前这么多行」：覆盖流式更新（消息总是追加在尾部）。 */
const REREAD_ROWS = 500

/**
 * 会话库缓存：rowid 增量 + 尾部重读。
 *
 * opencode 是先插入消息、流式过程中再更新 tokens（93,280/93,365 条 time_updated
 * 晚于 time_created），所以不能只按 rowid 追加：正在生成的那条会以空 token 被记住。
 * 重读用 rowid 而不是 time_updated：后者没索引，全表扫要 600ms。
 */
let sessionCache = null

const SESSION_SQL = `
  select rowid as rid, json_extract(data,'$.tokens.input') as i, json_extract(data,'$.tokens.output') as o,
         json_extract(data,'$.tokens.reasoning') as r, json_extract(data,'$.tokens.cache.read') as cr,
         json_extract(data,'$.tokens.cache.write') as cw, json_extract(data,'$.model.providerID') as prov,
         json_extract(data,'$.model.id') as model, time_created as t
  from session_message where type = 'assistant' and rowid > ?
`

function toRecord(row) {
  const model = String(row.model ?? '').trim()
  if (!model) return null
  const date = new Date(Number(row.t))
  if (Number.isNaN(date.getTime())) return null
  const input = Math.max(0, Number(row.i) || 0)
  // 网关的 out 含 reasoning，会话库单列：并进去才对得上
  const reasoning = Math.max(0, Number(row.r) || 0)
  const output = Math.max(0, Number(row.o) || 0) + reasoning
  const cacheRead = Math.max(0, Number(row.cr) || 0)
  const cacheWrite = Math.max(0, Number(row.cw) || 0)
  const price = lookupPrice(model)
  const pad = (value) => String(value).padStart(2, '0')
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    hour: pad(date.getHours()),
    agent: 'opencode',
    provider: String(row.prov ?? ''),
    model,
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    status: 200,
    tries: 1,
    cost: costOf(price, input, output, cacheRead, cacheWrite),
    priced: Boolean(price),
  }
}

function sameUsage(left, right) {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite
  )
}

/** opencode 会话库里的 assistant 消息（「本地会话」来源）。 */
export function loadSessionRecords() {
  const file = opencodeDbPath()
  if (!existsSync(file)) return sessionCache ? sessionCache.records : []
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
  } catch {
    return sessionCache ? sessionCache.records : []
  }
  try {
    // 库被重建/清空时 rowid 会回到小值：发现就丢掉缓存重新全量读
    if (sessionCache) {
      const maxRowid = Number(db.prepare('select max(rowid) as m from session_message').get()?.m ?? 0)
      if (maxRowid < sessionCache.lastRowid) sessionCache = null
    }
    // 每 60 秒对齐一次「库里还在的 rowid」：删掉的会话不能一直算进用量
    let pruned = false
    const nowSec = Math.floor(Date.now() / 1000)
    if (sessionCache && nowSec - sessionCache.prunedAt > 60) {
      const keep = new Set(db.prepare("select rowid as rid from session_message where type='assistant'").all().map((row) => Number(row.rid)))
      if (keep.size > 0) {
        for (const rid of [...sessionCache.map.keys()]) {
          if (!keep.has(rid)) {
            sessionCache.map.delete(rid)
            pruned = true
          }
        }
      }
      sessionCache.prunedAt = nowSec
    }
    const lastRowid = sessionCache ? sessionCache.lastRowid : 0
    const sinceRowid = lastRowid > REREAD_ROWS ? lastRowid - REREAD_ROWS : 0
    const rows = db.prepare(SESSION_SQL).all(sinceRowid)
    if (rows.length === 0) return sessionCache ? sessionCache.records : []

    let newRowid = lastRowid
    const parsed = []
    for (const row of rows) {
      const rid = Number(row.rid) || 0
      if (rid > newRowid) newRowid = rid
      const record = toRecord(row)
      if (record && rid > 0) parsed.push([rid, record])
    }

    // 变化检测：重读的旧行里 token 没变就不用重建 9 万条快照
    let changed = newRowid > lastRowid || pruned
    if (!changed && sessionCache) {
      changed = parsed.some(([rid, record]) => {
        const old = sessionCache.map.get(rid)
        return !old || !sameUsage(old, record)
      })
    }
    if (!changed) return sessionCache ? sessionCache.records : []

    const map = sessionCache ? sessionCache.map : new Map()
    for (const [rid, record] of parsed) map.set(rid, record)
    const records = [...map.values()]
    sessionCache = { lastRowid: newRowid, map, records, prunedAt: sessionCache ? sessionCache.prunedAt : nowSec }
    return records
  } catch {
    return sessionCache ? sessionCache.records : []
  } finally {
    db.close()
  }
}
