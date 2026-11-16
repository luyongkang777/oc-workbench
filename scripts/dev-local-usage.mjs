// dev 的用量接口：与外壳 `/local/usage` 同口径，数据源同样是
// 「magpie 网关日志 + opencode 会话库」。
//
// 只在 `npm run dev` 下生效。口径必须与 `shell/src/usage*.rs` 保持一致：
//   * token 默认含缓存（输入 + 输出 + 缓存读写），可切换；
//   * 命中率 = cacheRead / (input + cacheRead + cacheWrite)；
//   * 费用按 `shell/src/usage_prices.json` 估算，认不出就计入「未计价」；
//   * 网关日志里的 opencode 请求由会话库代表，避免重复计数。

import { loadRecords, loadSessionRecords, usageLogPath } from './dev-local-usage-data.mjs'

function emptyTotals() {
  return {
    calls: 0,
    errors: 0,
    retried: 0,
    canceled: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 0,
    unpriced: 0,
  }
}

function add(totals, record) {
  totals.calls += 1
  if (record.status === 499) totals.canceled += 1
  else if (record.status >= 400) totals.errors += 1
  else if (record.tries > 1) totals.retried += 1
  totals.input += record.input
  totals.output += record.output
  totals.cacheRead += record.cacheRead
  totals.cacheWrite += record.cacheWrite
  totals.reasoning += record.reasoning
  totals.cost += record.cost
  if (!record.priced && record.input + record.output + record.cacheRead > 0) totals.unpriced += 1
}

const round4 = (value) => Math.round(value * 10000) / 10000

function dayString(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function addDays(date, delta) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  next.setDate(next.getDate() + delta)
  return next
}

function totalsJson(totals) {
  return { ...totals, cost: round4(totals.cost) }
}

function sortedGroups(map, limit) {
  return [...map.entries()]
    .sort((left, right) => {
      const a = left[1].input + left[1].output + left[1].cacheRead
      const b = right[1].input + right[1].output + right[1].cacheRead
      return b - a || left[0].localeCompare(right[0])
    })
    .slice(0, limit)
    .map(([id, totals]) => ({ id, ...totalsJson(totals) }))
}

function seriesPoint(label, time, totals) {
  return {
    label,
    time,
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    calls: totals.calls,
    cost: round4(totals.cost),
  }
}

export function usageSummary({ period = 'all', provider = '', agent = '' } = {}) {
  const now = new Date()
  const todayText = dayString(now)
  let startDay = '0000-00-00'
  if (period === 'today') startDay = todayText
  else if (period === '7d') startDay = dayString(addDays(now, -6))
  else if (period === '30d') startDay = dayString(addDays(now, -29))
  const hourBuckets = period === 'today'

  // 两个来源：magpie 网关日志 + opencode 会话库（覆盖不走网关的本地调用）
  const file = usageLogPath()
  let records = []
  let gatewayError = null
  try {
    records = loadRecords(file)
  } catch (err) {
    gatewayError = err
  }
  const session = loadSessionRecords()
  if (gatewayError && session.length === 0) {
    if (gatewayError.code === 'ENOENT') {
      throw new Error(`没有找到 magpie 的用量日志（${file}）：装了 magpie 并跑过请求后才有数据`)
    }
    throw new Error(`读不了用量日志（${gatewayError.message}）：${file}`)
  }

  const totals = emptyTotals()
  const series = new Map()
  const agents = new Map()
  const providers = new Map()
  const models = new Map()
  let earliest = null

  const push = (record) => {
    if (record.day < startDay) return
    // 服务商分组全量（它是下拉选项来源），不受筛选影响
    if (!providers.has(record.provider)) providers.set(record.provider, emptyTotals())
    add(providers.get(record.provider), record)
    if (provider && record.provider !== provider) return
    if (agent && record.agent !== agent) return

    add(totals, record)
    const key = hourBuckets ? record.hour : record.day
    if (!series.has(key)) series.set(key, emptyTotals())
    add(series.get(key), record)
    if (!agents.has(record.agent)) agents.set(record.agent, emptyTotals())
    add(agents.get(record.agent), record)
    if (record.model) {
      if (!models.has(record.model)) models.set(record.model, emptyTotals())
      add(models.get(record.model), record)
    }
    if (!earliest || record.day < earliest) earliest = record.day
  }

  for (const record of records) {
    // 走网关的 opencode 请求在会话库里也有同一条：只保留会话库那份
    if (record.agent === 'opencode' && session.length > 0) continue
    push(record)
  }
  for (const record of session) push(record)

  const points = []
  if (hourBuckets) {
    for (let hour = 0; hour < 24; hour += 1) {
      const label = String(hour).padStart(2, '0')
      points.push(seriesPoint(label, '', series.get(label) ?? emptyTotals()))
    }
  } else {
    const start = startDay !== '0000-00-00' ? startDay : earliest || todayText
    let cursor = new Date(`${start}T00:00:00`)
    const end = new Date(`${todayText}T00:00:00`)
    const span = Math.round((end - cursor) / 86_400_000)
    if (span > 179) cursor = addDays(end, -179)
    while (cursor <= end) {
      const key = dayString(cursor)
      points.push(seriesPoint(key.slice(5), key, series.get(key) ?? emptyTotals()))
      cursor = addDays(cursor, 1)
    }
  }

  const prompt = totals.input + totals.cacheRead + totals.cacheWrite
  const source =
    session.length > 0
      ? records.length > 0
        ? 'magpie 网关日志 + opencode 会话库'
        : 'opencode 会话库'
      : 'magpie 网关日志'
  return {
    ok: true,
    period,
    bucket: hourBuckets ? 'hour' : 'day',
    source,
    generatedAt: todayText,
    totals: totalsJson(totals),
    hitRate: prompt > 0 ? totals.cacheRead / prompt : null,
    series: points,
    agents: sortedGroups(agents, 20),
    providers: sortedGroups(providers, 20),
    models: sortedGroups(models, 20),
  }
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export function localUsagePlugin() {
  return {
    name: 'oc-dev-local-usage',
    configureServer(server) {
      // 后台预热：首次打开面板不用等全量解析
      setTimeout(() => {
        try {
          loadRecords(usageLogPath())
        } catch {
          // 没有日志就跳过
        }
        try {
          loadSessionRecords()
        } catch {
          // 库被占/不存在就跳过
        }
      }, 800)
      server.middlewares.use((req, res, next) => {
        const raw = req.url ?? ''
        if (!raw.startsWith('/local/usage')) return next()
        const url = new URL(raw, 'http://127.0.0.1')
        res.setHeader('cache-control', 'no-store')
        try {
          sendJson(
            res,
            200,
            usageSummary({
              period: url.searchParams.get('period') || 'all',
              provider: url.searchParams.get('provider') || '',
              agent: url.searchParams.get('agent') || '',
            }),
          )
        } catch (err) {
          sendJson(res, 200, { ok: false, error: err.message })
        }
      })
    },
  }
}
