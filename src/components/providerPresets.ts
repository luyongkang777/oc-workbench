/**
 * 预设图标的资源映射。
 *
 * 为什么单独一个文件：`providerForm.ts` 会被 Node 单测直接 import（`--experimental-strip-types`），
 * 那里 import `.png` / `.svg` 会直接报错。所以纯数据放 `providerForm.ts`，
 * 真正的资源引用只在这个界面层文件里。
 *
 * 图标全部取自官方：
 *   * DeepSeek —— https://www.deepseek.com/favicon.ico（32bpp BMP 内嵌，转成 64px PNG）
 *   * OpenCode —— https://opencode.ai/favicon.svg
 *   * Command Code —— https://commandcode.ai/favicon/2024/android-chrome-192x192.png
 *   * WorkBuddy —— 桌面客户端 resources/icon.png（1024px 官方原图，缩成 64px）
 */
import commandCodeIcon from '../assets/providers/commandcode.png'
import deepseekIcon from '../assets/providers/deepseek.png'
import magpieIcon from '../assets/providers/magpie.svg'
import opencodeIcon from '../assets/providers/opencode.svg'
import workbuddyIcon from '../assets/providers/workbuddy.png'
import type { ProviderPreset } from './providerForm'

export const PRESET_ICONS: Record<ProviderPreset['icon'], string> = {
  deepseek: deepseekIcon,
  opencode: opencodeIcon,
  commandcode: commandCodeIcon,
  magpie: magpieIcon,
  workbuddy: workbuddyIcon,
}
