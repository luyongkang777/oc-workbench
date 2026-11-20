/**
 * 把模型调用失败的原因翻译成用户看得懂的中文。
 *
 * 为什么要有这一层：服务端给的是英文原文（`Free usage limit reached. Connect a provider
 * or subscribe to OpenCode Go to keep going, or switch models.`），工作台直接贴给用户看，
 * 等于没说。而且不同错误**该做的事完全不同**：
 *
 *   * 免费额度用光 —— 换模型，或等十几小时；不是「再试一次就好」
 *   * 密钥无效 —— 去设置里换 key
 *   * 模型不存在 —— 换模型
 *   * 上下文超限 —— 开新会话
 *
 * 所以这里按「类型 → 中文标题 + 中文做法」归类，原始英文放在 `raw` 里由界面放进悬停提示。
 * 全是纯函数，node 里能直接单测（scripts/failureText.test.mjs）。
 */

/** 失败归类的枚举。新增一类同时要补 `describeFailure` 与单测。 */
export type FailureKind =
  | 'free-limit'
  | 'rate-limit'
  | 'quota'
  | 'auth'
  | 'model-missing'
  | 'context'
  | 'network'
  | 'server'
  | 'unknown'

export type FailureText = {
  kind: FailureKind
  /** 一句话说清「为什么没跑完」 */
  title: string
  /** 一句话说清「现在该做什么」 */
  hint: string
  /** 原始英文原文（放进 title 属性，排查时还能看到） */
  raw: string
}

type Input = {
  message?: string
  type?: string
  status?: number
  retryAfterMs?: number
}

/**
 * 把毫秒说成「大约多久」。
 *
 * 只给粗略量级：这不是倒计时，用户只需要知道「等一会儿」还是「等到明天」。
 * 刻意显示中文单位（分钟 / 小时），不显示 `59181000ms` 这种原始数字。
 */
export function humanizeWait(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return '不到一分钟'
  if (minutes < 60) return `约 ${minutes} 分钟`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `约 ${hours} 小时`
  return `约 ${Math.round(hours / 24)} 天`
}

/** 免费额度用光的识别：服务端 type 是 `provider.free-limit`，文案里带 Free usage limit。 */
function isFreeLimit(input: Input, text: string): boolean {
  if (/free[-_. ]?limit/i.test(input.type ?? '')) return true
  if (/free[-_. ]?tier/i.test(input.type ?? '')) return true
  return /free usage limit|free tier|FreeUsageLimitError|FreeTierError/i.test(text)
}

/** 免费额度相关但属于「这次超了」的限流（区别于「整天额度用光」）。 */
function isRateLimit(input: Input, text: string): boolean {
  if (input.status === 429 && !isFreeLimit(input, text)) return true
  return /rate.?limit|too many requests|overloaded/i.test(text)
}

/** 余额/额度不足（付费通道）。 */
function isQuota(input: Input, text: string): boolean {
  return /insufficient (balance|credit|quota)|quota exceeded|余额不足|额度不足/i.test(text)
}

/** 密钥/鉴权。 */
function isAuth(input: Input, text: string): boolean {
  if (input.status === 401 || input.status === 403) return true
  return /invalid.{0,12}(api)?[_ ]?key|unauthorized|forbidden|permission denied|invalid credential/i.test(
    text,
  )
}

/** 模型不存在 / 不支持。 */
function isModelMissing(input: Input, text: string): boolean {
  return /model (unavailable|not found)|unsupported model|no-route|no such model/i.test(text)
}

/** 上下文超限。 */
function isContext(input: Input, text: string): boolean {
  return /context (length|window) exceed|too many tokens|maximum context/i.test(text)
}

/** 网络层。 */
function isNetwork(text: string): boolean {
  return /fetch failed|failed to fetch|networkerror|network error|econn(reset|refused|aborted)|epipe|etimedout|socket hang ?up|other side closed|连接.*(失败|中断|重置)|请求超时/i.test(
    text,
  )
}

/**
 * 归类 + 生成中文说明。
 *
 * 判定顺序是**从具体到笼统**：免费额度必须排在限流前面（它们都可能是 429），
 * 否则「额度用光」会被说成「稍后自动重试」，而实际上要等十几小时。
 */
export function describeFailure(input: Input | null | undefined): FailureText {
  // 归一化：后面的判据都按非空对象处理，省得每个函数都写一遍可选链
  const safe: Input = input ?? {}
  const message = (safe.message ?? '').trim()
  const type = (safe.type ?? '').trim()
  const raw = message || type || '服务端没有给出原因'
  const text = `${type} ${message}`.trim()
  const wait = humanizeWait(safe.retryAfterMs)

  if (isFreeLimit(safe, text)) {
    return {
      kind: 'free-limit',
      title: '免费模型的额度用光了',
      hint: wait
        ? `这类免费额度按 IP 计算，${wait}后恢复。现在可以换一个模型继续。`
        : '这类免费额度按 IP 计算，用光后要等一段时间恢复。现在可以换一个模型继续。',
      raw,
    }
  }
  if (isAuth(safe, text)) {
    return {
      kind: 'auth',
      title: '模型服务拒绝了这个密钥',
      hint: '到「第三方 API 接入」里检查这一条 API Key，或换一个服务商。',
      raw,
    }
  }
  if (isModelMissing(safe, text)) {
    return {
      kind: 'model-missing',
      title: '这个模型已经不在服务商那里了',
      hint: '在模型下拉里换一个，或回到「第三方 API 接入」重新获取模型列表。',
      raw,
    }
  }
  if (isContext(safe, text)) {
    return {
      kind: 'context',
      title: '这段对话超出了模型的上下文上限',
      hint: '开一个新会话，或先压缩（/compact）再继续。',
      raw,
    }
  }
  if (isQuota(safe, text)) {
    return {
      kind: 'quota',
      title: '这个服务商的余额或额度不够了',
      hint: '去服务商控制台充值，或换一个模型。',
      raw,
    }
  }
  if (isRateLimit(safe, text)) {
    return {
      kind: 'rate-limit',
      title: '请求太频繁，被服务商限流了',
      hint: '稍等一下再发，通常几秒到一分钟就恢复。',
      raw,
    }
  }
  if (isNetwork(text)) {
    return {
      kind: 'network',
      title: '连不上模型服务',
      hint: '检查网络或代理后重新发送，工作台也会自动重试几次。',
      raw,
    }
  }
  if (typeof safe.status === 'number' && safe.status >= 500) {
    return {
      kind: 'server',
      title: '模型服务自己出错了（服务端故障）',
      hint: '这通常是临时的，工作台会自动重试几次；一直失败就换模型。',
      raw,
    }
  }
  return {
    kind: 'unknown',
    title: '这一轮没有跑完',
    hint: '可以直接重新发送；一直失败就换一个模型试试。',
    raw,
  }
}
