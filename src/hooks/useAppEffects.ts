import { useEffect } from 'react'
import { onIpcMessage, startAuth } from '../api/auth'
import { SUBAGENT_OPEN_KEY } from '../appConfig'
import type { SubagentMode } from '../components/subagent'
import { nextThemePref, prefersDarkScheme, resolveTheme, themeLabel } from '../components/theme'
import type { ThemePref } from '../components/theme'

/**
 * App 级别的全局副作用（与具体领域无关、只需要跑一次的那种）。
 *
 * 抽出来是为了让 App 只剩「组装状态 + 提供 Context」，不被 6 个 effect 撑长。
 * 每个 effect 的注释保留在原来位置，方便对照。
 */
export function useAppEffects(options: {
  bumpTree: () => void
  notice: { text: string; id: number } | null
  setNotice: (next: { text: string; id: number } | null) => void
  notify: (text: string) => void
  themePref: ThemePref
  setThemePref: (next: ThemePref | ((cur: ThemePref) => ThemePref)) => void
  applyRoot: (input: string, opts?: { persist?: boolean }) => void
  subagentMode: SubagentMode
}) {
  const { bumpTree, notice, setNotice, notify, themePref, setThemePref, applyRoot, subagentMode } = options

  // 挂载即发起 IPC 握手；拿不到令牌只影响连接状态，不影响界面渲染。
  useEffect(() => {
    startAuth()
  }, [])

  // agent 改完文件后切回来，文件树自动刷新一次。
  useEffect(() => {
    window.addEventListener('focus', bumpTree)
    return () => window.removeEventListener('focus', bumpTree)
  }, [bumpTree])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timer)
  }, [notice, setNotice])

  // Ctrl/⌘ + Shift + L：循环切换主题（跟随系统 → 暗 → 浅），右下角浮层报一下当前状态
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return
      if (event.key.toLowerCase() !== 'l') return
      event.preventDefault()
      const next = nextThemePref(themePref)
      setThemePref(next)
      notify(`主题：${themeLabel(next, resolveTheme(next, prefersDarkScheme()))}`)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [themePref, setThemePref, notify])

  // 外壳消息：root:<path> 是启动时随令牌下发的上次根目录；
  // folder:<path> 是对话框选完的结果，空路径表示取消。
  useEffect(
    () =>
      onIpcMessage((message) => {
        // 外壳用系统浏览器打开链接失败时回这一条。
        if (message.startsWith('open-url-failed:')) {
          notify('用系统浏览器打开链接失败')
          return
        }
        if (message.startsWith('root:')) {
          const saved = message.slice('root:'.length).trim()
          // 启动恢复不算"用户切了项目"，不回写 root.txt：多个窗口同时启动会把 root.txt 拉来拉去
          if (saved) applyRoot(saved, { persist: false })
          return
        }
        if (!message.startsWith('folder:')) return
        const path = message.slice('folder:'.length).trim()
        if (path) applyRoot(path)
      }),
    // applyRoot 的回调都在 ref 里、依赖数组是空的，所以这里挂一次就够
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // 面板模式记到本地：下次打开还保持同样布局
  useEffect(() => {
    try {
      window.localStorage.setItem(SUBAGENT_OPEN_KEY, subagentMode)
    } catch {
      /* 存不进去只影响下次启动的默认值 */
    }
  }, [subagentMode])
}
