import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { persistProjects, startProjects } from '../api/projects'
import { ROOT_KEY } from '../appConfig'
import { normalizeRootPath } from '../components/localPath'
import {
  findProject,
  normKey,
  parseProjects,
  projectNameOf,
  removeProject,
  setProjectState,
  upsertProject,
  type Project,
} from '../components/projectList'

/**
 * 工作区：项目清单 + 当前根目录 + 每个项目的界面位置。
 *
 * 从 App.tsx 抽出来的。`rootRef` 由调用方创建并共享给 useFileTabs：
 * 文件标签那边只读它（判断「这个文件在不在工作区里」），这里负责写。
 *
 * 跨领域联动全部走回调（放在 ref 里，所以 applyRoot 的依赖数组是空的，
 * IPC 消息的 effect 才不会反复重订阅）：
 *  - `hasDirtyTabs`：切项目前问一句（未保存的改动会丢）
 *  - `currentUiState`：记下要离开的那个项目停在哪个文件/视图
 *  - `onProjectSwitched`：切到新项目后恢复它的界面（视图/文件/关旧面板）
 */
export function useWorkspace(options: {
  rootRef: MutableRefObject<string>
  hasDirtyTabs: () => boolean
  currentUiState: () => { file: string | null; view: 'code' | 'diff' }
  onProjectSwitched: (state?: { file?: string | null; view?: 'code' | 'diff' }) => void
  /** 当前界面位置，变了就防抖写回项目清单 */
  uiSnapshot: { file: string | null; view: 'code' | 'diff' }
}) {
  const { rootRef, uiSnapshot } = options

  const cb = useRef(options)
  cb.current = options

  const [root, setRoot] = useState(() => {
    try {
      return window.localStorage.getItem(ROOT_KEY) || ''
    } catch {
      // localStorage 被禁用时不能白屏，退回「还没选项目」
      return ''
    }
  })
  rootRef.current = root

  // 项目清单：一个目录一个项目，点一下就切过去，每个项目各自记着自己的界面状态
  const [projects, setProjects] = useState<Project[]>([])
  // IPC 回调里拿不到最新的 state，用 ref 兜
  const projectsRef = useRef<Project[]>([])
  projectsRef.current = projects

  /** 更新清单并立刻落盘（外壳写 projects.json）。 */
  const commitProjects = useCallback((next: Project[]) => {
    projectsRef.current = next
    setProjects(next)
    persistProjects(next)
  }, [])

  /** 记住当前目录：root.txt 跨启动，localStorage 只管 dev 刷新。 */
  const rememberRoot = useCallback((path: string) => {
    try {
      window.localStorage.setItem(ROOT_KEY, path)
    } catch {
      // 忽略：仅影响 dev 刷新恢复
    }
    const w = window as unknown as { ipc?: { postMessage(message: string): void } }
    w.ipc?.postMessage(`oc:save-root:${path}`)
  }, [])

  /**
   * 切到某个目录：既是「打开文件夹」，也是「切换项目」。
   * 切走时把当前项目的位置记下来，切回来时恢复它自己上次的样子。
   *
   * `persist: false` 用于「启动时恢复上次目录」：只切界面，不把 root.txt 再写一遍。
   * 否则两个窗口各恢复一次就会互相覆盖 root.txt，来回打架。
   */
  const applyRoot = useCallback(
    (input: string, opts?: { persist?: boolean }) => {
      const persist = opts?.persist !== false
      // 手输/粘贴/外壳下发的路径先抹平：引号、正反斜杠、/c/ 风格、file://、尾斜杠。
      const path = normalizeRootPath(input)
      if (!path) return

      // 同一目录：只补刷新持久化，不清掉正在看的文件（选同一文件夹/重试都会走到这）。
      if (normKey(rootRef.current) === normKey(path)) {
        commitProjects(upsertProject(projectsRef.current, path, { lastUsed: Date.now() }))
        if (persist) rememberRoot(path)
        return
      }

      if (cb.current.hasDirtyTabs() && !window.confirm('有文件还没保存，切换项目会丢弃修改，继续？')) {
        return
      }

      let next = upsertProject(projectsRef.current, path, { lastUsed: Date.now() })
      const leaving = rootRef.current
      if (leaving) next = setProjectState(next, leaving, { ...cb.current.currentUiState() })
      const target = findProject(next, path)
      commitProjects(next)

      rootRef.current = path
      setRoot(path)
      if (persist) rememberRoot(path)

      // 每个项目都是自己的界面：恢复它上次停在哪个文件、哪个视图
      cb.current.onProjectSwitched(target?.state)
    },
    [rootRef, commitProjects, rememberRoot],
  )

  const forgetProject = useCallback(
    (path: string) => {
      const next = removeProject(projectsRef.current, path)
      commitProjects(next)
      // 删掉的正好是当前项目：切到清单里第一个，别停在一个已经不在列表里的目录
      if (normKey(path) === normKey(rootRef.current)) {
        const fallback = next[0]
        if (fallback) applyRoot(fallback.path)
      }
    },
    [rootRef, commitProjects, applyRoot],
  )

  // 选文件夹：外壳通过 IPC 弹原生对话框；dev/浏览器退化成输入框。
  const pickFolder = useCallback(() => {
    const w = window as unknown as { ipc?: { postMessage(message: string): void } }
    if (w.ipc?.postMessage) {
      w.ipc.postMessage('oc:pick-folder')
      return
    }
    const value = window.prompt('输入文件夹路径（可直接粘贴带引号的路径）', rootRef.current)
    if (value) applyRoot(value)
  }, [rootRef, applyRoot])

  // 启动时拉起项目清单。外壳回的清单可能比「刚打开的这个目录」旧（两条 IPC 到达顺序不定），
  // 所以跟本地已有的合并，别把用户刚打开的项目覆盖掉。
  useEffect(() => {
    const stop = startProjects((list) => {
      const merged = parseProjects([...list, ...projectsRef.current])
      const current = rootRef.current
      const hasActive = current && merged.some((p) => normKey(p.path) === normKey(current))
      const withActive =
        current && !hasActive
          ? parseProjects([...merged, { path: current, name: projectNameOf(current) }])
          : merged
      projectsRef.current = withActive
      setProjects(withActive)
      persistProjects(withActive)

      // 没有任何当前项目（首次启动 / 记录被清掉）时，自动打开最近用的那个。
      // 目录已被删掉也照切：文件树会给出明确报错，用户能从首页换一个。
      if (!current && withActive.length > 0) {
        applyRoot(withActive[0].path, { persist: false })
        return
      }
      // 这次启动打开的是哪个项目，就恢复它上次停的位置
      const state = findProject(withActive, current)?.state
      if (!state) return
      cb.current.onProjectSwitched(state)
    })
    return stop
  }, [applyRoot, rootRef])

  // 文件/视图变了就把位置写回当前项目。防抖：连点一串文件不会一路写盘。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const current = rootRef.current
      if (!current) return
      const next = setProjectState(projectsRef.current, current, {
        file: uiSnapshot.file,
        view: uiSnapshot.view,
      })
      if (next === projectsRef.current) return
      projectsRef.current = next
      setProjects(next)
      persistProjects(next)
    }, 800)
    return () => window.clearTimeout(timer)
  }, [uiSnapshot.file, uiSnapshot.view, rootRef])

  return { root, projects, applyRoot, forgetProject, pickFolder, commitProjects }
}
