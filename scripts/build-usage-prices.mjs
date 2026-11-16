// 生成 `shell/src/usage_prices.json`：models.dev 的模型价格精简表。
//
// 为什么提交进仓库而不是运行时拉：用量页要能离线算钱，也不能每次打开都外联。
// 价格变动时重跑本脚本即可（node scripts/build-usage-prices.mjs）。
//
// 取值口径（对齐 magpie 的「maker price」）：
//   1. 同一个模型 id 在多个 provider 出现时，优先取厂商官方 provider 的价；
//   2. 没有官方条目时取所有来源里的最低价（中转站通常加价，最低价最接近官方）；
//   3. 价格单位是 USD / 1M tokens（models.dev 的约定）。
import { writeFileSync } from 'node:fs'

const OUT = 'shell/src/usage_prices.json'
const SOURCE = 'https://models.dev/api.json'

/** 厂商官方 provider：价格优先取这些。 */
const OFFICIAL = new Set([
  'deepseek',
  'anthropic',
  'openai',
  'google',
  'google-vertex',
  'google-vertex-anthropic',
  'xai',
  'zhipuai',
  'moonshotai',
  'minimax',
  'alibaba',
  'stepfun',
  'meta',
  'mistral',
  'cohere',
  'volcengine',
])

const res = await fetch(SOURCE, { headers: { 'user-agent': 'oc-workbench' } })
if (!res.ok) throw new Error(`拉 models.dev 失败：HTTP ${res.status}`)
const catalog = await res.json()

const best = new Map()
for (const [provider, info] of Object.entries(catalog)) {
  for (const [id, model] of Object.entries(info.models ?? {})) {
    const cost = model.cost
    if (!cost || typeof cost.input !== 'number') continue
    // 0 价条目（免费额度 / 未定价）不可信：留着会把整条模型算成 $0
    if ((cost.input ?? 0) + (cost.output ?? 0) <= 0) continue
    const price = [
      Number(cost.input),
      Number(cost.output ?? cost.input),
      Number(cost.cache_read ?? 0),
      Number(cost.cache_write ?? 0),
    ]
    if (price.some((n) => !Number.isFinite(n))) continue
    const key = id.toLowerCase()
    const current = best.get(key)
    const official = OFFICIAL.has(provider)
    if (!current) {
      best.set(key, { price, official })
      continue
    }
    if (official && !current.official) {
      best.set(key, { price, official })
      continue
    }
    if (official === current.official && price[0] < current.price[0]) {
      best.set(key, { price, official })
    }
  }
}

const models = {}
for (const id of [...best.keys()].sort()) {
  models[id] = best.get(id).price
}

const payload = {
  source: SOURCE,
  generatedAt: new Date().toISOString(),
  /** 每项是 [input, output, cache_read, cache_write]，单位 USD / 1M tokens。 */
  models,
}
writeFileSync(OUT, `${JSON.stringify(payload)}\n`, 'utf8')
console.log(`wrote ${OUT}: ${Object.keys(models).length} models, ${JSON.stringify(payload).length} bytes`)
