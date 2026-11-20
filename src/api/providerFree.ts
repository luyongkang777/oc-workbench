import type { ModelOption } from './providerFormat.ts'

/**
 * 「只接免费模型」的判定与过滤（纯函数，可被 Node 单测直接跑）。
 *
 * 为什么要单独一层：opencode 免费池的 `/models` 会**同时**返回付费模型，
 * 实测 91 个里只有 14 个真免费（`cost.text.input.price` 与 `cost.text.output.price` 都是 0）。
 * 用户勾了付费模型保存，第一次发消息就是 402 Insufficient balance，
 * 而且错误文案看起来像「余额不足」，很难联想到「这个模型本来就要钱」。
 *
 * 所以预设带一个 `filter: 'free'`，拉完清单先过滤再进界面。
 */

/** 表单当前的过滤模式：空串 = 全部（付费 provider 都走这个）。 */
export type ModelFilter = '' | 'free'

/**
 * 这条模型是不是免费的。
 *
 * 只看上游自己声明的价格：`free` 字段由解析层按 `cost` 算好。
 * **没有 `cost` 字段的一律不算免费**——DeepSeek / Command Code 这类接口根本不报价格，
 * 把「没说价格」当成免费会让界面把整份清单当免费放过去。
 */
export function isFreeModel(model: ModelOption): boolean {
  return model.free === true
}

/**
 * 这条模型能不能当对话模型用（唯一放行 `chat`，其余一律排除）。
 *
 * 免费池实测有五种 `type`（2026-11-20，103 个模型）：
 *   * `chat`（83 个）—— 正常对话，放行；
 *   * `embedding`（12 个）—— 只能算向量，发对话请求必失败；
 *   * `decision`（4 个）—— 内部决策模型；
 *   * `image`（3 个）—— 画图；
 *   * `realtime`（1 个）—— 实时语音/流式专用。
 *
 * 所以这里是**白名单**（只认 chat），不是黑名单：上游以后再加新类型时，
 * 默认也会被排掉，不会把不能对话的模型混进「免费对话模型」清单里。
 * 没有 `type` 字段时按 chat 处理（多数 OpenAI 兼容接口不给这个字段）。
 */
export function isChatModel(model: ModelOption): boolean {
  const kind = (model.type ?? '').trim().toLowerCase()
  return !kind || kind === 'chat'
}

/**
 * 按模式过滤清单。
 *
 * `'free'` = 免费 **且** 能对话。两个条件都要，少一个就会留下选不出结果的条目。
 */
export function filterModels(models: ModelOption[], mode: ModelFilter): ModelOption[] {
  if (mode !== 'free') return models
  return models.filter((model) => isFreeModel(model) && isChatModel(model))
}

/**
 * 拉完模型后给用户看的那句话。
 *
 * 三种情况分开说，别只报一个数字：
 *   * 没过滤（付费 provider）：直接说拉到几个；
 *   * 过滤后一个都没剩：多半是上游不再返回 `cost` 字段，得告诉用户还能怎么办；
 *   * 正常过滤：说清「上游给了 N 个、只留 M 个」，否则 91 → 11 看着像勾选丢了。
 */
export function fetchModelsMessage(total: number, kept: number, filter: ModelFilter): string {
  if (filter !== 'free') return `拉到 ${total} 个模型`
  if (kept > 0) return `上游返回 ${total} 个，只保留 ${kept} 个免费对话模型（付费/图像类已过滤）`
  if (total > 0) {
    return (
      `上游返回 ${total} 个模型，但没识别出免费模型（可能上游没报价格）。` +
      '可以先切到「自定义」手动勾选，或稍后再试。'
    )
  }
  return '上游没有返回任何模型'
}
