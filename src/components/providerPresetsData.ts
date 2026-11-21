import { DEEPSEEK_BASE_URL } from '../api/providerFormat.ts'
import type { ModelFilter } from '../api/providerFree.ts'

/**
 * 预设数据与地址识别（纯数据 + 纯函数，不含表单状态）。
 *
 * 为什么单独一个文件：`providerForm.ts` 已经装了表单状态机、模型合并、保存清单，
 * 再加五个预设与地址反查就破 300 行墙。这里只放「有哪些预设」和「这个地址属于哪一条」，
 * 与表单如何组装无关。
 */

/**
 * OpenCode Go 套餐端点。
 *
 * 不能写成 `https://opencode.ai/zen/v1`：那是按量付费（credits）网关，
 * 套餐请求打到那里会被判成 pay-as-you-go，回 402 Insufficient balance，
 * 文案还写着「OpenCode Go covers only requests to the OpenCode Go provider」，
 * 看起来像套餐过期，实际是地址接错了。
 */
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/inference/go/openai/v1'

/** opencode 免费池地址（key 就是字面量 `public`，不需要登录）。 */
export const OPENCODE_FREE_BASE_URL = 'https://opencode.ai/inference/openai/v1'

/** 免费池的 key：上游只认这一串字面量，随便填别的会 403。 */
export const OPENCODE_FREE_KEY = 'public'

/** Magpie 网关地址：本机固定端口，OpenAI 兼容层挂在 `/v1` 下。 */
export const MAGPIE_BASE_URL = 'http://127.0.0.1:3425/v1'

export type ProviderPreset = {
  id: string
  name: string
  baseURL: string
  icon: 'deepseek' | 'opencode' | 'commandcode' | 'magpie' | 'workbuddy'
  /**
   * 预设自带的默认 key。
   *
   * 本地网关（Magpie）没有鉴权，Bearer 带什么都能过；免费池只认字面量 `public`。
   * 但表单校验要求 key 非空，预设直接填好，省得用户对着「请填 API Key」发呆。
   */
  apiKey?: string
  /**
   * 拉完模型清单后只留哪些。
   *
   * `'free'` 用在 opencode 免费池：它的 `/models` 会**同时**返回付费模型
   * （实测 91 个里只有 14 个免费），勾到付费的就是第一次发消息 402 余额不足。
   */
  filter?: ModelFilter
}

/**
 * WorkBuddy 的本地转发端点。
 *
 * baseURL 留空是有意的：exe 的端口是随机的，远程入口还多一层 `/u/<id>/` 前缀，
 * 只能由界面按当前 origin 现拼。这个常量只用来给 provider 列表配图标与 id。
 */
export const WORKBUDDY_PRESET: ProviderPreset = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  baseURL: '',
  icon: 'workbuddy',
}

/**
 * 所有预设。
 *
 * ID 必须避开 opencode 内置的 provider 名（deepseek / opencode / opencode-go / commandcode…）：
 * 用内置 ID 时 opencode 会把它自己那份模型目录合并进来（实测 `opencode` 写 12 个模型会显示 89 个，
 * `whitelist`/`blacklist` 都不生效），于是「没勾选的模型也会出现在下拉里」。
 * 换成自定义 ID 后，配置里写几个就是几个（实测写 3 个 = 显示 3 个）。
 */
export const PRESETS: ProviderPreset[] = [
  { id: 'deepseek-official', name: 'DeepSeek 官方', baseURL: DEEPSEEK_BASE_URL, icon: 'deepseek' },
  // id 保持 `opencode-zen`（历史名字），不要换成 `opencode-go`：
  //   1. 那是 opencode 内置 provider 名，会把自己那份模型目录合并进来，勾选失效；
  //   2. 老配置里存的也是 `opencode-zen`，换了会让同一条变成两个 provider。
  // 名字与地址才是给用户看的，id 只是键。
  { id: 'opencode-zen', name: 'OpenCode Go', baseURL: OPENCODE_GO_BASE_URL, icon: 'opencode' },
  // opencode 自带免费模型：key 是字面量 public，只留免费对话模型。
  // id 不能叫 `opencode`（内置名会把自家模型目录合并进来，勾选失效）。
  {
    id: 'opencode-free',
    name: 'OpenCode 免费模型',
    baseURL: OPENCODE_FREE_BASE_URL,
    icon: 'opencode',
    apiKey: OPENCODE_FREE_KEY,
    filter: 'free',
  },
  {
    id: 'command-code',
    name: 'Command Code',
    baseURL: 'https://api.commandcode.ai/provider/v1',
    icon: 'commandcode',
  },
  // Magpie 是本地网关：WorkBuddy（要在 Magpie 里浏览器登录）、ZCode、Cursor 等都从这里出。
  // id 不带后缀，opencode 里的模型 id 才短（`magpie/workbuddy/deepseek-v4.1-flash`）。
  {
    id: 'magpie',
    name: 'Magpie 网关',
    baseURL: MAGPIE_BASE_URL,
    icon: 'magpie',
    apiKey: 'magpie',
  },
]

/** 按 id 取预设。 */
export function presetById(id: string): ProviderPreset | null {
  return PRESETS.find((preset) => preset.id === id) ?? null
}

/** 按 baseURL 的 host / 路径找预设，用来给列表里的条目配图标。 */
export function presetForBaseURL(raw: string): ProviderPreset | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  let host = ''
  let pathname = ''
  try {
    const url = new URL(text.includes('://') ? text : `https://${text}`)
    // 用 host（含端口）而不是 hostname：本机网关靠端口区分（127.0.0.1:3425）
    host = url.host.toLowerCase()
    pathname = url.pathname
  } catch {
    return null
  }
  // WorkBuddy 的本地转发：端口随机，只能靠路径认
  if (pathname.includes('/local/workbuddy/v1')) return WORKBUDDY_PRESET
  // 本机梯子转发（/local/relay/<secret>/go|cc）：dev 里界面拿到的是原始地址，
  // 外壳会还原成上游；两边都认，图标才不会退化成首字母。
  if (pathname.includes('/local/relay/')) {
    const tail = pathname.slice(pathname.indexOf('/local/relay/') + '/local/relay/'.length)
    // 当前格式是 <secret>/go；旧格式可能只有 go（与 relay.rs 的宽松解析保持一致）
    const parts = tail.split('/')
    const key = parts.length > 1 ? parts[1] : parts[0]
    if (key === 'go') return presetById('opencode-zen')
    if (key === 'cc') return presetById('command-code')
  }
  // opencode.ai 下有三个通道，同一 host 只能靠路径区分：
  //   /inference/openai/v1     免费池（key=public）
  //   /inference/go/openai/v1  Go 套餐
  //   /zen/v1                  按量付费
  if (host === 'opencode.ai') {
    if (pathname.startsWith('/inference/openai/')) return presetById('opencode-free')
    return presetById('opencode-zen')
  }
  const known: Record<string, string> = {
    'api.deepseek.com': 'deepseek-official',
    'deepseek.com': 'deepseek-official',
    'api.commandcode.ai': 'command-code',
    'commandcode.ai': 'command-code',
    '127.0.0.1:3425': 'magpie',
    'localhost:3425': 'magpie',
  }
  const id = known[host]
  return id ? presetById(id) : null
}
