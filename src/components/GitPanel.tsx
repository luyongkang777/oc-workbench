import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'

import {
  commitChanges,
  discardPaths,
  fetchGitStatus,
  fetchGitTree,
  fetchLog,
  initRepo,
  pushRepo,
  rollbackTo,
  setIgnore,
  setRemote,
  type GitCommit,
  type GitLog,
  type GitStatus,
  type GitTreeEntry,
} from '../api/git'
import { Icon } from './Icon'
import {
  describePushResult,
  relativeTime,
  statusLabel,
  statusTone,
  summarizeChanges,
  syncLabel,
} from './git/gitFormat'
import GitGraph from './git/GitGraph'
import RemotePicker from './git/RemotePicker'

type GitPanelProps = {
  /** 绝对路径 */
  root: string
  open: boolean
  onClose: () => void
  onOpenFile: (relPath: string) => void
}

type Tab = 'changes' | 'ignore' | 'history'

const TABS: { key: Tab; label: string }[] = [
  { key: 'changes', label: '改动' },
  { key: 'ignore', label: '排除' },
  { key: 'history', label: '历史' },
]

/** 打开时的轮询间隔：git 状态很便宜，5 秒够跟上编辑器外的改动。 */
const POLL_MS = 5000
/** 错误提示条自动消失时间 */
const ERROR_MS = 5000
/** 成功提示（推送完成之类）比错误短：它只是确认动作生效了 */
const NOTICE_MS = 4000
/** 文件树拖拽契约里约定的 MIME（见 docs/git-panel-contract.md §4） */
const DRAG_MIME = 'application/x-oc-path'
/** 历史每页条数：加载更多一次加这么多 */
const HISTORY_PAGE = 50
/** 历史条数上限，和后端约定一致 */
const HISTORY_LIMIT_MAX = 200

/**
 * 极简中文化 git 面板。
 *
 * 打开才挂载内容，关闭直接返回 null（不留在 DOM 里吃点击）。
 * 状态每 5 秒轮询一次；所有写操作成功后都立刻重拉，避免界面和后端不同步。
 */
export default function GitPanel({ root, open, onClose, onOpenFile }: GitPanelProps) {
  const [tab, setTab] = useState<Tab>('changes')
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 成功提示（推送完成之类）：和 error 分开，绿色，4 秒后自己消失
  const [notice, setNotice] = useState<string | null>(null)

  const [message, setMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [initializing, setInitializing] = useState(false)

  const [remotePickerOpen, setRemotePickerOpen] = useState(false)

  const [tree, setTree] = useState<Record<string, GitTreeEntry[]>>({})
  const [treeBusy, setTreeBusy] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<string[]>([])
  const [ignoring, setIgnoring] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const [history, setHistory] = useState<GitLog | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE)

  const [rolling, setRolling] = useState<GitCommit | null>(null)
  const [rollingBusy, setRollingBusy] = useState<'soft' | 'hard' | null>(null)
  const [discarding, setDiscarding] = useState<string | null>(null)

  // 代际标记：root 变了或面板关了之后，在途请求的结果一律丢弃
  const genRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  // 已经拉过哪几层目录（空串 = 根目录），避免切页签时重复请求
  const treeLoadedRef = useRef<Set<string>>(new Set())

  /** 拉状态。quiet=true 用于轮询：不点亮 loading，也不清掉已有数据。 */
  const load = useCallback(
    async (quiet = false) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const gen = ++genRef.current

      if (!quiet) setLoading(true)
      try {
        const next = await fetchGitStatus(root, controller.signal)
        if (gen !== genRef.current || controller.signal.aborted) return
        setStatus(next)
        if (!quiet) setError(null)
      } catch (err) {
        if (gen !== genRef.current || controller.signal.aborted) return
        const text = (err as Error).message
        // 轮询失败会每 5 秒重复同一句，值没变就别重启动画/计时
        setError((prev) => (prev === text ? prev : text))
      } finally {
        if (gen === genRef.current) setLoading(false)
      }
    },
    [root],
  )

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      // 一次拿到 commits / branches / head / detached，历史页签只发这一次请求
      const res = await fetchLog(root, historyLimit)
      setHistory({
        commits: res.commits ?? [],
        branches: res.branches ?? [],
        head: res.head ?? '',
        detached: res.detached ?? false,
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setHistoryLoading(false)
    }
  }, [root, historyLimit])

  /** 加载更多：historyLimit 变了 → loadHistory 换了引用 → 上面那个 effect 重新拉 */
  function handleLoadMore() {
    if (historyLoading || historyLimit >= HISTORY_LIMIT_MAX) return
    setHistoryLimit((prev) => Math.min(prev + HISTORY_PAGE, HISTORY_LIMIT_MAX))
  }

  const loadTree = useCallback(
    async (dir: string) => {
      setTreeBusy((prev) => ({ ...prev, [dir]: true }))
      try {
        const entries = await fetchGitTree(root, dir || undefined)
        treeLoadedRef.current.add(dir)
        setTree((prev) => ({ ...prev, [dir]: entries }))
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setTreeBusy((prev) => {
          if (!prev[dir]) return prev
          const next = { ...prev }
          delete next[dir]
          return next
        })
      }
    },
    [root],
  )

  // 打开 / 换目录：清空全部本地视图状态，立刻拉一次，然后开始轮询
  useEffect(() => {
    if (!open) {
      // 面板关了就不能让选择器留在打开状态，下次进来会莫名其妙盖一层
      setRemotePickerOpen(false)
      return
    }

    setStatus(null)
    setError(null)
    // 换目录时上一轮的「已推送」提示不能跟过来
    setNotice(null)
    setTab('changes')
    setMessage('')
    setTree({})
    setTreeBusy({})
    setExpanded([])
    setDragOver(false)
    setHistory(null)
    setHistoryLimit(HISTORY_PAGE)
    setRolling(null)
    setRemotePickerOpen(false)
    treeLoadedRef.current = new Set()

    void load()
    const timer = window.setInterval(() => {
      void load(true)
    }, POLL_MS)

    return () => {
      window.clearInterval(timer)
      genRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [open, root, load])

  // 错误条 5 秒自动消失；可以手动点掉
  useEffect(() => {
    if (!error) return
    const timer = window.setTimeout(() => setError(null), ERROR_MS)
    return () => window.clearTimeout(timer)
  }, [error])

  // 成功提示 4 秒自动消失：比错误短一点，它只是确认动作生效了
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  // 切到历史页签时拉一次（空仓库返回空数组）
  useEffect(() => {
    if (!open || tab !== 'history') return
    void loadHistory()
  }, [open, tab, loadHistory])

  // 切到排除页签时拉根目录这一层（只拉一层，展开时再往下走）
  useEffect(() => {
    if (!open || tab !== 'ignore') return
    if (treeLoadedRef.current.has('')) return
    void loadTree('')
  }, [open, tab, loadTree])

  async function handleInit() {
    if (initializing) return
    setInitializing(true)
    try {
      await initRepo(root)
      await load()
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setInitializing(false)
    }
  }

  async function handleCommit() {
    const text = message.trim()
    if (!text || committing) return
    setCommitting(true)
    try {
      await commitChanges(root, text)
      setMessage('')
      await load(true)
      if (tab === 'history') await loadHistory()
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCommitting(false)
    }
  }

  async function handlePush() {
    if (pushing) return
    setPushing(true)
    try {
      const result = await pushRepo(root)
      // 先刷状态（领先/落后、上次提交），再刷历史（未推送标记要跟着变）
      await load(true)
      if (tab === 'history') await loadHistory()
      setError(null)
      setNotice(describePushResult(result.output, result.branch))
    } catch (err) {
      setNotice(null)
      setError((err as Error).message)
    } finally {
      setPushing(false)
    }
  }

  async function handleDiscard(path: string) {
    if (discarding) return
    setDiscarding(path)
    try {
      await discardPaths(root, [path])
      await load(true)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDiscarding(null)
    }
  }

  /** 选定地址后统一落地：写 origin，再重拉一次状态。 */
  async function applyRemote(url: string) {
    try {
      await setRemote(root, url)
      await load(true)
      setError(null)
    } catch (err) {
      // Picker 触发时已经关闭，失败只能回到面板的错误条
      setError((err as Error).message)
    }
  }

  async function handleRollback(mode: 'soft' | 'hard') {
    if (!rolling || rollingBusy) return
    setRollingBusy(mode)
    try {
      await rollbackTo(root, rolling.hash, mode)
      setRolling(null)
      await load(true)
      await loadHistory()
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRollingBusy(null)
    }
  }

  /** 重置文件树并重拉根目录：排除规则变了，ignored 标记全要重算 */
  async function refreshTree() {
    treeLoadedRef.current = new Set()
    setTree({})
    setExpanded([])
    await loadTree('')
  }

  async function handleIgnore(paths: string[]) {
    if (paths.length === 0) return
    setIgnoring(paths[0])
    try {
      await setIgnore(root, paths, 'add')
      await refreshTree()
      await load(true)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIgnoring(null)
    }
  }

  function toggleDir(dir: string) {
    if (expanded.includes(dir)) {
      setExpanded(expanded.filter((item) => item !== dir))
      return
    }
    setExpanded([...expanded, dir])
    if (!treeLoadedRef.current.has(dir)) void loadTree(dir)
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    // 不 preventDefault 浏览器不会把这里当落点
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    if (!dragOver) setDragOver(true)
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    // 在子元素之间移动也会触发 dragleave，relatedTarget 还在容器里就不算离开
    const next = event.relatedTarget as Node | null
    if (next && event.currentTarget.contains(next)) return
    setDragOver(false)
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragOver(false)
    const raw = event.dataTransfer.getData(DRAG_MIME)
    if (!raw) return
    // 文件树按契约只放一条，但多选批量时也允许换行分隔
    const paths = Array.from(
      new Set(
        raw
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    )
    void handleIgnore(paths)
  }

  /** 递归渲染一层目录；展开的那层用 state 里缓存的子项。 */
  function renderTree(dir: string, depth: number): ReactNode {
    const entries = tree[dir]
    if (!entries) return treeBusy[dir] ? <div className="git-tree-loading">读取中…</div> : null
    if (entries.length === 0) {
      return depth === 0 ? <div className="git-empty">这个目录是空的</div> : null
    }

    return entries.map((entry) => {
      const isDir = entry.type === 'directory'
      const opened = isDir && expanded.includes(entry.path)
      const busy = ignoring === entry.path
      return (
        <div className="git-tree-branch" key={entry.path}>
          <div className="git-tree-row" style={{ paddingLeft: 6 + depth * 14 }}>
            <button
              type="button"
              className="git-tree-toggle"
              onClick={() => (isDir ? toggleDir(entry.path) : undefined)}
              disabled={!isDir}
              aria-expanded={isDir ? opened : undefined}
              title={isDir ? (opened ? '收起' : '展开') : '文件'}
            >
              <Icon name={isDir ? (opened ? 'folder-open' : 'folder') : 'file'} size={14} />
            </button>
            <span className="git-tree-name" title={entry.path}>
              {entry.name}
            </span>
            {entry.ignored ? <span className="git-tree-ignored">已排除</span> : null}
            {!entry.ignored ? (
              <button
                type="button"
                className="git-tree-exclude"
                onClick={() => void handleIgnore([entry.path])}
                disabled={busy}
              >
                {busy ? '排除中…' : '排除'}
              </button>
            ) : null}
          </div>
          {opened ? renderTree(entry.path, depth + 1) : null}
        </div>
      )
    })
  }

  // 关闭时完全不渲染：留在 DOM 里会吃掉底下的点击
  if (!open) return null

  const initialized = status?.initialized === true

  return (
    <div className="git-panel">
      <div className="git-head">
        <span className="git-title">
          <Icon name="git" size={15} />
          版本管理
        </span>
        <button type="button" className="git-close" onClick={onClose} title="关闭">
          <Icon name="close" size={14} />
        </button>
      </div>

      {error ? (
        <div className="git-error" role="alert">
          <Icon name="warn" size={14} />
          <span className="git-error-text">{error}</span>
          <button type="button" className="git-error-close" onClick={() => setError(null)} title="关闭提示">
            <Icon name="close" size={12} />
          </button>
        </div>
      ) : notice ? (
        <div className="git-notice" role="status">
          <Icon name="check" size={14} />
          <span className="git-notice-text">{notice}</span>
          <button type="button" className="git-notice-close" onClick={() => setNotice(null)} title="关闭提示">
            <Icon name="close" size={12} />
          </button>
        </div>
      ) : null}

      {status === null ? (
        <div className="git-empty">{loading ? '正在读取仓库状态…' : '还没读到仓库状态'}</div>
      ) : !initialized ? (
        <div className="git-init">
          <div className="git-init-text">
            这个目录还不是一个可管理的仓库。初始化之后就能提交改动、推送和回滚。
          </div>
          <button
            type="button"
            className="git-init-btn"
            onClick={() => void handleInit()}
            disabled={initializing}
          >
            <Icon name="git" size={15} />
            {initializing ? '初始化中…' : '初始化 Git 仓库'}
          </button>
        </div>
      ) : (
        <>
          <div className="git-statusbar">
            <span className="git-branch" title={status.branch || '没有分支'}>
              <Icon name="git" size={13} />
              {status.detached ? '游离状态' : status.branch || '没有分支'}
            </span>
            <span className="git-sync">{syncLabel(status.ahead, status.behind, status.noUpstream)}</span>
            <span className="git-last">
              {status.lastCommit ? `上次提交 ${relativeTime(status.lastCommit.time)}` : '还没有提交'}
            </span>
          </div>

          <div className="git-remote-row">
            <span
              className={`git-remote${status.remote ? '' : ' empty'}`}
              title={status.remote || '还没设置远程地址'}
            >
              {status.remote || '还没设置远程地址'}
            </span>
            <button
              type="button"
              className="git-remote-edit"
              onClick={() => setRemotePickerOpen(true)}
            >
              设置远程
            </button>
          </div>

          <div className="git-tabs">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`git-tab${tab === item.key ? ' active' : ''}`}
                onClick={() => setTab(item.key)}
              >
                {item.label}
                {item.key === 'changes' && status.files.length > 0 ? (
                  <span className="git-tab-count">{status.files.length}</span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="git-body">
            {tab === 'changes' ? (
              <>
                <div className="git-section">
                  <div className="git-section-head">
                    <span className="git-section-title">改动</span>
                    <span className="git-section-count">{summarizeChanges(status.files)}</span>
                  </div>

                  <div className="git-change-list">
                    {status.files.length === 0 ? (
                      <div className="git-empty">没有未提交的改动</div>
                    ) : (
                      status.files.map((file) => (
                        <div className="git-change" key={file.path}>
                          <span className={`git-change-badge git-tone-${statusTone(file.status)}`}>
                            {statusLabel(file.status)}
                          </span>
                          <button
                            type="button"
                            className="git-change-path"
                            title={file.path}
                            onClick={() => onOpenFile(file.path)}
                          >
                            {file.path}
                          </button>
                          {file.staged ? <span className="git-change-flag">已暂存</span> : null}
                          <button
                            type="button"
                            className="git-discard"
                            onClick={() => void handleDiscard(file.path)}
                            disabled={discarding === file.path}
                          >
                            {discarding === file.path ? '撤销中…' : '撤销'}
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="git-commit">
                  <textarea
                    className="git-commit-input"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="写一句这次改了什么"
                    rows={3}
                    spellCheck={false}
                  />
                  <div className="git-commit-actions">
                    <span className="git-commit-hint">
                      {message.trim() ? `${message.trim().length} 个字` : '提交说明不能为空'}
                    </span>
                    <button
                      type="button"
                      className="git-primary"
                      onClick={() => void handleCommit()}
                      disabled={!message.trim() || committing}
                    >
                      {committing ? '提交中…' : '提交'}
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            {tab === 'ignore' ? (
              <div
                className={`git-dropzone${dragOver ? ' dragging' : ''}`}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
              >
                <div className="git-drop-hint">把文件或目录拖到这里，就会加进排除列表</div>
                <div className="git-tree">{renderTree('', 0)}</div>
              </div>
            ) : null}

            {tab === 'history' ? (
              history === null ? (
                <div className="git-empty">{historyLoading ? '正在读取历史…' : '还没读到历史'}</div>
              ) : (
                <>
                  <GitGraph
                    commits={history.commits}
                    head={history.head}
                    detached={history.detached}
                    onRollback={(commit) => setRolling(commit)}
                  />
                  {history.commits.length >= historyLimit && historyLimit < HISTORY_LIMIT_MAX ? (
                    <div className="git-graph-more">
                      <button type="button" onClick={handleLoadMore} disabled={historyLoading}>
                        {historyLoading ? '读取中…' : '加载更多'}
                      </button>
                    </div>
                  ) : null}
                </>
              )
            ) : null}
          </div>

          <div className="git-actions">
            <button
              type="button"
              className="git-push"
              onClick={() => void handlePush()}
              disabled={pushing}
            >
              {pushing ? '推送中…' : '推送到远程'}
            </button>
            <button
              type="button"
              className="git-refresh"
              onClick={() => void load()}
              disabled={loading}
            >
              <Icon name="refresh" size={13} />
              {loading ? '刷新中' : '刷新'}
            </button>
          </div>
        </>
      )}

      {rolling ? (
        <div className="git-confirm-layer" role="dialog" aria-modal="true">
          <div className="git-confirm-card">
            <div className="git-confirm-title">回滚到 {rolling.short}</div>
            <div className="git-confirm-text">「{rolling.message || '（没有说明）'}」</div>
            <div className="git-confirm-note">保留我的改动：这次提交之后的改动会回到工作区，内容不会丢。</div>
            <div className="git-confirm-note">丢弃改动：这次提交之后的所有改动都会消失，找不回来。</div>
            <div className="git-confirm-actions">
              <button
                type="button"
                className="git-confirm-soft"
                onClick={() => void handleRollback('soft')}
                disabled={rollingBusy !== null}
              >
                {rollingBusy === 'soft' ? '回滚中…' : '保留我的改动'}
              </button>
              <button
                type="button"
                className="git-confirm-hard"
                onClick={() => void handleRollback('hard')}
                disabled={rollingBusy !== null}
              >
                {rollingBusy === 'hard' ? '回滚中…' : '丢弃改动'}
              </button>
              <button
                type="button"
                className="git-confirm-cancel"
                onClick={() => setRolling(null)}
                disabled={rollingBusy !== null}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <RemotePicker
        root={root}
        open={remotePickerOpen}
        current={status?.remote ?? ''}
        onPick={(url) => void applyRemote(url)}
        onClose={() => setRemotePickerOpen(false)}
      />
    </div>
  )
}
