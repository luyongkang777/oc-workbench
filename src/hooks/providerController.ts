import type { ProviderStatus } from '../api/provider'
import type { ProviderQuota, ProviderUsage } from '../api/providerQuota'
import type { ProviderPreset } from '../components/providerPresetsData'
import type { ProviderInfo } from '../api/provider'
import type { FormState } from '../components/providerForm'

/**
 * 面板与界面之间的那一个契约对象。
 *
 * 单独成文件的原因：`useProviderPanel.ts` 已经装了全部状态与动作，
 * 类型块再留在这里就破 300 行墙；而且界面组件只要这个类型，
 * 不需要把整份 hook 实现拖进类型依赖里。
 */
export type ProviderController = {
  status: ProviderStatus | null
  /** providerID → 额度（DeepSeek 有金额，其它只有控制台地址） */
  quota: Record<string, ProviderQuota>
  /** providerID → 本机累计消耗 */
  usage: Record<string, ProviderUsage>
  loading: boolean
  busy: boolean
  /** 正在重新拉额度（与保存/删除的 busy 分开，互不阻塞） */
  quotaBusy: boolean
  message: string | null
  form: FormState
  models: string[]
  saveDisabled: boolean
  /** 编辑已有的一条；传 null 表示新建 */
  edit: (info: ProviderInfo | null) => void
  preset: (preset: ProviderPreset) => void
  /** 一键接入：套预设 → 拉模型 → 优先勾选指定前缀（Magpie 用 `workbuddy/`） */
  connectPreset: (preset: ProviderPreset, preferPrefix?: string) => Promise<void>
  patch: (field: keyof FormState, value: string) => void
  fetchModels: () => Promise<void>
  save: () => Promise<void>
  remove: (id: string) => Promise<void>
  reload: () => Promise<ProviderStatus | null>
  /** 手动刷新所有服务商的额度 + 本机用量 */
  refreshQuota: () => Promise<void>
  toggle: (modelId: string) => void
  /** 全选 / 全不选（模型多的服务商一键处理） */
  selectAll: (checked: boolean) => void
  /** 改某个模型的上下文 / 输出上限 */
  limit: (modelId: string, field: 'context' | 'output', raw: string) => void
  normalizedBase: string
}
