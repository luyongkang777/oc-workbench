/**
 * 第三方 API 接入的纯函数：地址规范化、密钥掩码、草稿校验、模型合并。
 *
 * 全部零依赖、不碰 DOM / fetch，方便直接单测（`scripts/providerFormat.test.mjs`）。
 *
 * 为什么要单独一层：`opencode.json` 里一条 provider 有 id / name / baseURL / apiKey /
 * models 五个字段，字段名与校验规则在外壳（Rust）、dev（Node）、界面（TS）三处都要一致。
 * 三份实现各写一遍必然漂移，所以「怎么算合法」只在 TS 里定义一次，Rust/Node 只做
 * 同样口径的保守校验（宁可拒掉也不写坏文件）。
 */

/** DeepSeek 官方端点。`/v1` 必须带上，OpenAI 兼容层挂在它下面。 */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'

/** 一条 provider 草稿（界面上的表单值）。 */
export type ProviderDraft = {
  /** 写进 opencode.json 的键名，切模型时就是 providerID */
  id: string
  /** 界面与模型下拉里显示的名字 */
  name: string
  baseURL: string
  apiKey: string
}

/** 从上游 /models 拿到的一条模型（带上下文与输出上限）。 */
export type ModelOption = {
  id: string
  /** 显示名（上游给的 name，或由 id 推导） */
  name: string
  /** 上下文长度（token）；0 表示上游没给 */
  context: number
  /** 单次输出上限（token）；0 表示上游没给 */
  output: number
}

/** 校验结果：ok=false 时 `error` 是一句能直接显示给用户的话。 */
export type DraftCheck = { ok: true } | { ok: false; error: string }

/**
 * 规范化 baseURL。
 *
 *   * 去首尾空白与尾部所有斜杠（`https://x/v1/` → `https://x/v1`）
 *   * 只接受 http / https（`ftp:`、`file:` 一律不合法）
 *   * 用户只填域名根（`https://api.deepseek.com`）时补 `/v1`：
 *     OpenAI 兼容层几乎都在 `/v1` 下，不补就是 404，用户很难自己看出原因。
 *   * 已经以版本段结尾（`/v1`、`/v2`、`/v1beta`、`/openai/v1`）的不补
 */
export function normalizeBaseURL(raw: string): string {
  const text = (raw ?? '').trim()
  if (!text) return ''

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  // 搜索串和锚点在 baseURL 里没有意义，去掉免得拼请求时出错
  url.search = ''
  url.hash = ''

  let path = url.pathname.replace(/\/+$/, '')
  // 已经带版本段就原样（`/v1` / `/v2` / `/v1beta` / `/openai/v1`）
  if (!/\/v\d+[a-z0-9]*$/i.test(path)) {
    path = `${path}/v1`
  }
  return `${url.origin}${path}`
}

/**
 * 密钥掩码：只露头尾各 4 个字符。
 *
 * 太短（<12）直接整串打星——露 8 个字符等于把 key 说出去一半。
 */
export function maskKey(key: string | undefined): string {
  const text = (key ?? '').trim()
  if (!text) return ''
  if (text.length < 12) return '*'.repeat(text.length)
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}

/**
 * 模型 id → 人话名字。
 *
 * 上游 `/models` 多数会给 `name`（"Claude Sonnet 5.5"），没有时才用这个按 id 拆词。
 * 规则：取最后一段（去掉 `vendor/` 前缀）→ 分隔符换空格 → 常见品牌保留专有写法 →
 * 其余首字母大写、版本号（v4.1 / 5-5）保持数字。
 */
export function prettyModelName(id: string): string {
  const raw = (id ?? '').trim()
  if (!raw) return ''
  // 上游已经给了人话名字（含空格）就原样用，别再拆词——
  // "Claude Sonnet 5.5" 被按 `.\ 拆开会变成 "Claude Sonnet 5 5"。
  if (/\s/.test(raw)) return raw
  const last = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
  // 只按 - _ / 空格拆；**不拆点**，否则 v4.1 会变成 "v4 1"
  const words = last.split(/[-_/\s]+/).filter(Boolean)
  const brands: Record<string, string> = {
    deepseek: 'DeepSeek',
    openai: 'OpenAI',
    gpt: 'GPT',
    glm: 'GLM',
    claude: 'Claude',
    gemini: 'Gemini',
    qwen: 'Qwen',
    kimi: 'Kimi',
    mimo: 'MiMo',
    grok: 'Grok',
    llama: 'Llama',
    mistral: 'Mistral',
    minimax: 'MiniMax',
    nemotron: 'Nemotron',
    sonnet: 'Sonnet',
    opus: 'Opus',
    haiku: 'Haiku',
  }
  return words
    .map((word) => {
      const lower = word.toLowerCase()
      if (brands[lower]) return brands[lower]
      // v4.1 / 4.1 / 500k 这类保持原样（首字母大写即可）
      if (/^v?\d/i.test(word)) return word.charAt(0).toUpperCase() + word.slice(1)
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
    .replace(/\bFree\b/i, 'Free')
}

/**
 * 写进配置的模型名：`DeepSeek V4.1 Flash (OpenCode Go)`。
 *
 * 括号里固定是**商家显示名**——opencode 的下拉本来就按 provider 分组，
 * 但导出的模型名/日志里没有供应商会分不清两家同名的 deepseek。
 */
export function modelDisplayName(source: string, providerName: string): string {
  const base = prettyModelName(source) || (source ?? '').trim()
  const provider = (providerName ?? '').trim()
  if (!base) return provider
  if (!provider) return base
  // 已经带了同样的括号就别重复
  if (base.endsWith(`(${provider})`)) return base
  return `${base} (${provider})`
}

/** provider id 只允许字母数字与 `.` `_` `-`：它会进 JSON 键、URL、模型 id 前缀。 */
const ID_PATTERN = /^[A-Za-z0-9._-]+$/

export function validateDraft(draft: ProviderDraft): DraftCheck {
  const id = (draft.id ?? '').trim()
  if (!id) return { ok: false, error: '请填一个 ID（例如 deepseek）' }
  if (!ID_PATTERN.test(id)) {
    return { ok: false, error: 'ID 只能用字母、数字、点、下划线、短横线' }
  }
  if (id.length > 64) return { ok: false, error: 'ID 太长（最多 64 个字符）' }

  const base = normalizeBaseURL(draft.baseURL)
  if (!base) return { ok: false, error: '接口地址必须是完整的 http(s) 地址' }

  const key = (draft.apiKey ?? '').trim()
  if (!key) return { ok: false, error: '请填 API Key' }
  if (/\s/.test(key)) return { ok: false, error: 'API Key 里不能有空格或换行' }

  return { ok: true }
}

/**
 * 合并模型 id：远端拉到的 ∪ 已经启用的，去重后排序。
 *
 * 为什么要并集而不是覆盖：远端 `/models` 有时会漏掉用户手填的模型（中转站把
 * 某些模型藏起来），直接覆盖会让已启用的模型在界面上「凭空消失」，看着像被删了。
 */
export function mergeModelIds(remote: string[] | undefined, existing: string[] | undefined): string[] {
  const seen = new Set<string>()
  for (const id of [...(existing ?? []), ...(remote ?? [])]) {
    const text = (id ?? '').trim()
    if (text) seen.add(text)
  }
  return [...seen].sort((left, right) => left.localeCompare(right))
}

/**
 * 从 `/models` 的响应里挑出模型 id。
 *
 * OpenAI 兼容层实际有三种形状，都要认：
 *   * `{ data: [{ id }] }`          —— 标准 OpenAI
 *   * `[{ id }]`                    —— 少数中转站直接回数组
 *   * `{ models: [{ name | id }] }` —— 部分国产服务
 */
export function pickModelIds(payload: unknown): string[] {
  const list: string[] = []

  const push = (value: unknown) => {
    if (typeof value === 'string') {
      const text = value.trim()
      if (text) list.push(text)
      return
    }
    if (!value || typeof value !== 'object') return
    const item = value as { id?: unknown; name?: unknown; model?: unknown }
    for (const field of [item.id, item.name, item.model]) {
      if (typeof field === 'string' && field.trim()) {
        list.push(field.trim())
        return
      }
    }
  }

  if (Array.isArray(payload)) {
    for (const item of payload) push(item)
    return [...new Set(list)]
  }
  if (payload && typeof payload === 'object') {
    const map = payload as { data?: unknown; models?: unknown }
    for (const field of [map.data, map.models]) {
      if (Array.isArray(field)) for (const item of field) push(item)
    }
  }
  return [...new Set(list)]
}
