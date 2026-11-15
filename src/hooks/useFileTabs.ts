import { useCallback, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { resolveBareName } from '../components/bareName'
import { MAX_FILE_TABS, fileTabKey, tabName, trimTabs, type FileTab } from '../components/fileTabModel'
import { splitOpenPath } from '../components/localPath'
import { normKey } from '../components/projectList'

/**
 * 「查看区打开的文件标签」的全部状态与操作。
 *
 * 从 App.tsx 抽出来的。所有标签状态（含 ref 快照）都在这里，外部只需要：
 *  - `rootRef`：当前工作区根（用 ref 是为了让回调读到最新值，不必重建回调）
 *  - `notify`：弹一句提示
 *  - `onOpened`：打开文件后的界面联动（切回代码视图 / 手机上跳到编辑栏）
 *  - `onTreeStale`：文件可能变了，让文件树重拉
 */
export function useFileTabs(options: {
  rootRef: MutableRefObject<string>
  notify: (text: string) => void
  onOpened: () => void
  /** 只是切回代码视图（点标签栏时用，不跳编辑栏） */
  onViewCode: () => void
  onTreeStale: () => void
}) {
  const { rootRef, notify, onOpened, onViewCode, onTreeStale } = options

  const [fileTabs, setFileTabs] = useState<FileTab[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const fileTabsRef = useRef(fileTabs)
  fileTabsRef.current = fileTabs
  const activeFileRef = useRef(activeFile)
  activeFileRef.current = activeFile

  // 哪些标签里有未保存的改动：关标签 / 切项目前拦一下。
  // 用 state 是为了让标签栏的圆点跟着刷新，ref 供事件回调同步读取。
  const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(() => new Set())
  const dirtyTabsRef = useRef(dirtyTabs)
  dirtyTabsRef.current = dirtyTabs

  // 当前激活标签（null 表示一个文件都没开）
  const activeTab = fileTabs.find((tab) => tab.key === activeFile) ?? null
  // 派生值：很多地方（文件树高亮、项目状态持久化）只关心「现在看的是哪个文件」
  const file = activeTab?.path ?? null
  const fileRoot = activeTab?.root ?? null

  /** 路径比较统一用 projectList 的 normKey（去尾分隔符、正反斜杠归一、小写） */
  const normPath = normKey


  // 只切换「看哪个文件」；读取/分页/虚拟滚动都由 CodeView 自己管，别让 App 跟着重渲染。
  const openFile = useCallback(
    (relPath: string, line?: number, edit?: boolean) => {
      // 聊天里的路径常是绝对路径（`C:\...`、`/c/...`），而本地文件通道只收相对 root 的
      // 路径，盘符那一段会被当成非法片段 400 拒掉。落在工作区外就临时换成它所在目录当
      // root —— 只影响编辑器，不改当前工作区，会话和文件树都留在原处。
      const target = splitOpenPath(rootRef.current, relPath)
      if (!target.path) return

      const open = (finalPath: string) => {
        const sameRoot = normPath(target.root) === normPath(rootRef.current)
        const tabRoot = sameRoot ? null : target.root
        const key = fileTabKey(tabRoot, finalPath)
        const jumpLine = typeof line === 'number' && Number.isFinite(line) ? line : null
        // 用 ref 当快照：连续点两个文件时 setState 还没落地，靠 state 会丢掉前一个标签。
        const tabs = fileTabsRef.current
        const hit = tabs.find((tab) => tab.key === key)
        let next: FileTab[]
        if (hit) {
          // 已经开着：切过去并按这次点击重读（同一个文件点两次也要刷新）
          next = tabs.map((tab) =>
            tab.key === key
              ? {
                  ...tab,
                  seq: tab.seq + 1,
                  line: jumpLine,
                  editSeq: edit ? tab.editSeq + 1 : tab.editSeq,
                }
              : tab,
          )
        } else {
          next = [
            ...tabs,
            { key, path: finalPath, root: tabRoot, seq: 1, line: jumpLine, editSeq: edit ? 1 : 0 },
          ]
          const trimmed = trimTabs(next, key, activeFileRef.current, dirtyTabsRef.current)
          next = trimmed.next
          if (trimmed.dropped) {
            notify(`最多同时打开 ${MAX_FILE_TABS} 个文件，先关掉几个`)
          }
        }
        // 先同步 ref 再 setState：同一帧里再点别的文件也不会基于旧列表算
        fileTabsRef.current = next
        activeFileRef.current = key
        setFileTabs(next)
        setActiveFile(key)
        // 停在「审查」面板时点路径/文件树也要有反应：切回代码视图
        onOpened()
      }

      // 裸文件名（不带目录）先定位，别拿它去工作区根上硬拼一个不存在的路径
      if (!/[\\/]/.test(target.path)) {
        void resolveBareName(target.root, target.path).then((hit) => {
          if (!hit) {
            notify(`找不到文件：${target.path}`)
            // 顺手刷新文件树：多半是刚被删掉/改名的旧条目
            onTreeStale()
            return
          }
          if (hit.path !== target.path) {
            notify(
              hit.total > 1
                ? `已定位到 ${hit.path}（同名 ${hit.total} 个）`
                : `已定位到 ${hit.path}`,
            )
          }
          open(hit.path)
        })
        return
      }

      open(target.path)
    },
    [rootRef, notify, onOpened, onTreeStale, normPath],
  )

  /** 换一组打开的文件（切项目 / 启动恢复）：传 null 清空，传路径开成唯一标签。 */
  const resetTabs = useCallback((path: string | null) => {
    // 换一套文件时旧标签的未保存标记必须清掉，否则新标签会被误判成脏的
    const emptyDirty = new Set<string>()
    dirtyTabsRef.current = emptyDirty
    setDirtyTabs(emptyDirty)
    if (!path) {
      fileTabsRef.current = []
      activeFileRef.current = null
      setFileTabs([])
      setActiveFile(null)
      return
    }
    const key = fileTabKey(null, path)
    const next = [{ key, path, root: null, seq: 1, line: null, editSeq: 0 }]
    // ref 要同步写：同一 tick 里 hasDirtyTabs / closeTab / openFile 读的都是 ref。
    fileTabsRef.current = next
    setFileTabs(next)
    setActiveFile(key)
  }, [])

  /** 把某个标签重新开进当前工作区（点「外部文件」标记时，applyRoot 会清空标签，这里补回来）。 */
  const reopenTab = useCallback((tab: FileTab) => {
    const key = fileTabKey(null, tab.path)
    const clearedDirty = new Set<string>()
    dirtyTabsRef.current = clearedDirty
    setDirtyTabs(clearedDirty)
    const next = [
      { key, path: tab.path, root: null, seq: tab.seq + 1, line: tab.line, editSeq: tab.editSeq },
    ]
    fileTabsRef.current = next
    activeFileRef.current = key
    setFileTabs(next)
    setActiveFile(key)
  }, [])

  /** 某个标签的未保存状态变了：更新集合（标签栏的圆点靠它刷新）。 */
  const handleTabDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyTabs((prev) => {
      if (prev.has(key) === dirty) return prev
      const next = new Set(prev)
      if (dirty) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  /** 点标签栏切到某个文件：不重读，保留那个标签自己的滚动位置和编辑草稿。 */
  const selectTab = useCallback((key: string) => {
    if (key === activeFileRef.current) return
    activeFileRef.current = key
    setActiveFile(key)
    onViewCode()
  }, [onViewCode])

  /** 某个标签是否有未保存改动（标签栏画圆点用；依赖 state 才会跟着刷新）。 */
  const isTabDirty = useCallback((key: string) => dirtyTabs.has(key), [dirtyTabs])

  /** 关掉一个标签（标签栏的 × / 中键 / 路径栏的 × 都走这里）。 */
  const closeTab = useCallback((key: string) => {
    const tabs = fileTabsRef.current
    const index = tabs.findIndex((tab) => tab.key === key)
    if (index < 0) return
    const tab = tabs[index]
    if (
      dirtyTabsRef.current.has(key) &&
      !window.confirm(`「${tabName(tab.path)}」有未保存的修改，确定关闭？`)
    ) {
      return
    }
    const next = tabs.filter((item) => item.key !== key)
    fileTabsRef.current = next
    setFileTabs(next)
    if (activeFileRef.current === key) {
      // 关的是当前标签：激活右边那个，没有就左边
      const fallback = next[Math.min(index, next.length - 1)]
      const nextKey = fallback ? fallback.key : null
      activeFileRef.current = nextKey
      setActiveFile(nextKey)
    }
  }, [])

  /** 关掉全部标签（有未保存改动先问一句）。 */
  const closeAllTabs = useCallback(() => {
    if (dirtyTabsRef.current.size > 0 && !window.confirm('有文件还没保存，确定全部关闭？')) {
      return
    }
    fileTabsRef.current = []
    activeFileRef.current = null
    setFileTabs([])
    setActiveFile(null)
    setDirtyTabs(new Set())
  }, [])

  /** 文件树删除/重命名前用来判断「有没有未保存的改动」 */
  const hasDirtyTabs = useCallback(() => dirtyTabsRef.current.size > 0, [])

  /** 保存后文件大小/行数变了，让文件树重拉一次 */
  const handleEditorSaved = useCallback(() => onTreeStale(), [onTreeStale])

  /**
   * 编辑器打不开某个文件：多半是文件树里残留的旧条目（文件已被删/改名）。
   * 提示一句并刷新文件树，旧条目自己就消失了，不用用户手动点「刷新」。
   */
  const handleOpenFailed = useCallback(
    (target: string, message: string) => {
      notify(`打不开 ${target}：${message}`)
      onTreeStale()
    },
    [notify, onTreeStale],
  )

  /** 文件树里删掉了东西：打开着的它（或它的子文件）对应的标签一起关掉。 */
  const handlePathRemoved = useCallback((removed: string) => {
    const target = removed.replace(/[\\/]+$/, '')
    if (!target) return
    const tabs = fileTabsRef.current
    const next = tabs.filter((tab) => {
      const hit =
        tab.path === target ||
        tab.path.startsWith(`${target}\\`) ||
        tab.path.startsWith(`${target}/`)
      return !hit
    })
    if (next.length === tabs.length) return
    fileTabsRef.current = next
    setFileTabs(next)
    if (!next.some((tab) => tab.key === activeFileRef.current)) {
      const nextKey = next[next.length - 1]?.key ?? null
      activeFileRef.current = nextKey
      setActiveFile(nextKey)
    }
  }, [])

  /**
   * 重命名：只改标签里的 path，key 保持不变。
   * key 变了会让 React 卸载重挂 CodeView，正在编辑的草稿和滚动位置就跟着丢了。
   */
  const handlePathRenamed = useCallback((from: string, to: string) => {
    const source = from.replace(/[\\/]+$/, '')
    if (!source) return
    const tabs = fileTabsRef.current
    let changed = false
    const next = tabs.map((tab) => {
      let path = tab.path
      if (tab.path === source) path = to
      else if (tab.path.startsWith(`${source}\\`) || tab.path.startsWith(`${source}/`)) {
        path = `${to}${tab.path.slice(source.length)}`
      }
      if (path === tab.path) return tab
      changed = true
      return { ...tab, path }
    })
    if (!changed) return
    fileTabsRef.current = next
    setFileTabs(next)
  }, [])

  return {
    fileTabs,
    activeFile,
    activeTab,
    file,
    fileRoot,
    dirtyTabs,
    openFile,
    resetTabs,
    selectTab,
    closeTab,
    closeAllTabs,
    handleTabDirty,
    isTabDirty,
    hasDirtyTabs,
    handleEditorSaved,
    handleOpenFailed,
    handlePathRemoved,
    handlePathRenamed,
    reopenTab,
  }
}
