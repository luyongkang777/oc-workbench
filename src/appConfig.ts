/**
 * App 级别的存储键与默认值。
 *
 * 全是「写进 localStorage 的键名」，集中放在这里避免拼错；
 * 各 hook 自己私有的键（主题、探活间隔）留在各自的文件里。
 */

/** 记在本地：'auto' / 'open' / 'closed'；老值 '1' / '0' 兼容成 open / closed。 */
export const SUBAGENT_OPEN_KEY = 'oc-workbench:subagent-open'

/**
 * 没有历史记录时的工作区。
 *
 * 必须留空：以前这里写的是开发机上的一个绝对路径，换台电脑那个目录不存在，
 * 首屏就是一棵报错的空文件树。空字符串表示「还没选项目」，界面走 WelcomePane。
 */
export const DEFAULT_ROOT = ''

/** 当前打开的项目路径。 */
export const ROOT_KEY = 'oc-workbench:root'


/**
 * 读一次「返回本机」的目标地址。
 *
 * 只在首次渲染调用（useState 惰性初始化）：认证握手里的 captureRemoteToken()
 * 会改写 location.hash（去掉 ?t=），如果每次渲染都重新读 hash，返回按钮会时有时无。
 */
export function readRemoteBack(): string {
  const hash = window.location.hash || ''
  const match = /[#?&]back=([^&]+)/.exec(hash)
  if (!match) return ''
  try {
    return decodeURIComponent(match[1])
  } catch {
    return ''
  }
}
