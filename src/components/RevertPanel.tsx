import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchTurnDiff, type ChatMessage, type TurnDiffFile } from '../api/chat'
import DiffBody from './DiffBody'
import { readWrapPref, writeWrapPref } from './wrapPrefs'
import { buildRevertNodes, filesSummary, nodeSummary, type RevertNode } from './revertNodes'

type Props = {
  /** 当前会话；没有会话时整个面板显示空状态 */
  sessionID: string | null
  /** 会话消息（服务端顺序：最新在前），由 Chat 传进来 */
  messages: ChatMessage[]
  /** 项目根：只用于记忆「换行」偏好，和审查面板共用一份 */
  root: string
  /** 生成中 / 已在回撤状态时不允许再回撤 */
  busy: boolean
  /** 已处于回撤状态：按钮要压暗，避免把边界挪来挪去 */
  reverted: boolean
  /** 回到这个节点（会连带还原文件，可再取消） */
  onRevert: (node: RevertNode) => void
  onClose: () => void
}

const STATUS_MARK: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
}

/**
 * 修改记录：最近 10 个节点，先审核再回溯。
 *
 * 两栏布局和「审查」面板一致（左列表、右 diff），但语义不同：
 *   - 审查面板看的是**工作区未提交的改动**；
 *   - 这里看的是**某一轮对话改了哪些文件**，而且是只读的
 *     （`/diff?from=<消息id>`，不碰磁盘）。
 *
 * 所以「审核」可以随便点，只有底部那个按钮才会真的回撤 —— 而且回撤仍然可以取消。
 */
export default function RevertPanel({
  sessionID,
  messages,
  root,
  busy,
  reverted,
  onRevert,
  onClose,
}: Props) {
  const nodes = useMemo(() => buildRevertNodes(messages), [messages])
  const [activeID, setActiveID] = useState<string | null>(null)
  const [files, setFiles] = useState<TurnDiffFile[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wrap, setWrap] = useState(() => readWrapPref(root))
  // 在途请求的世代号：切节点时旧响应必须丢弃，否则会把上一个节点的 diff 显示出来
  const genRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  // 节点列表变了（新发了一轮 / 会话切了）就回到最近一轮
  useEffect(() => {
    const first = nodes[0]?.messageID ?? null
    setActiveID((current) => {
      if (current && nodes.some((node) => node.messageID === current)) return current
      return first
    })
  }, [nodes])

  useEffect(() => {
    setWrap(readWrapPref(root))
  }, [root])

  const active = nodes.find((node) => node.messageID === activeID) ?? null

  /** 拉某一轮的 diff。只读接口，切来切去不会动磁盘。 */
  const load = useCallback(
    async (messageID: string) => {
      if (!sessionID) {
        setFiles([])
        return
      }
      genRef.current += 1
      const gen = genRef.current
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setLoading(true)
      setError(null)
      try {
        const list = await fetchTurnDiff(sessionID, messageID, controller.signal)
        if (genRef.current !== gen) return
        setFiles(list)
        setSelected((current) =>
          current && list.some((file) => file.file === current) ? current : (list[0]?.file ?? null),
        )
      } catch (err) {
        if (genRef.current !== gen) return
        if ((err as Error).name === 'AbortError') return
        setFiles([])
        setSelected(null)
        // 404 是常见情况：那一轮没改任何文件时服务端也会报没有可比的快照
        setError(`读取这一轮的改动失败：${(err as Error).message}`)
      } finally {
        if (genRef.current === gen) setLoading(false)
      }
    },
    [sessionID],
  )

  // Esc 关闭：和别处浮层一致；正在读 diff 也照样关，不留个孤儿面板
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (activeID) void load(activeID)
    else {
      setFiles([])
      setSelected(null)
    }
  }, [activeID, load])


  // 切会话时立刻清空：否则新会话面板会先闪一下上一个会话的 diff
  useEffect(() => {
    setFiles([])
    setSelected(null)
    setError(null)
  }, [sessionID])

  // 组件卸载时掐掉在途请求
  useEffect(() => () => abortRef.current?.abort(), [])

  const toggleWrap = useCallback(() => {
    setWrap((current) => {
      const next = !current
      writeWrapPref(root, next)
      return next
    })
  }, [root])

  const current = files.find((file) => file.file === selected) ?? files[0] ?? null
  const canRevert = Boolean(active) && !busy && !reverted

  return (
    <div className="revert-panel" role="dialog" aria-label="修改记录">
      <div className="revert-head">
        <span className="revert-title">修改记录</span>
        <span className="revert-count">
          {nodes.length === 0 ? '还没有修改' : `最近 ${nodes.length} 个节点`}
        </span>
        <button
          type="button"
          className={`revert-wrap${wrap ? ' active' : ''}`}
          onClick={toggleWrap}
          title="长行是否折行显示"
          aria-pressed={wrap}
        >
          换行
        </button>
        <button type="button" className="revert-close" onClick={onClose} title="关闭（Esc）">
          ×
        </button>
      </div>

      {nodes.length === 0 ? (
        <div className="revert-empty">
          这个会话还没有可以回溯的修改。
          <br />
          让模型改一次文件之后，这里会列出每一轮改了什么。
        </div>
      ) : (
        <div className="revert-main">
          <div className="revert-list">
            {nodes.map((node) => (
              <button
                key={node.messageID}
                type="button"
                className={`revert-node${node.messageID === activeID ? ' active' : ''}`}
                onClick={() => setActiveID(node.messageID)}
                title={node.text || nodeSummary(node)}
              >
                <span className="revert-node-index">#{node.index}</span>
                <span className="revert-node-text">{nodeSummary(node)}</span>
              </button>
            ))}
          </div>

          <div className="revert-diff">
            <div className="revert-diff-head">
              <span className="revert-diff-stat">
                {loading ? '读取改动中…' : error ? '这一轮的改动读不到' : filesSummary(files)}
              </span>
              {files.length > 1 ? (
                <span className="revert-file-tabs">
                  {files.map((file) => {
                    const mark = STATUS_MARK[file.status] ?? 'M'
                    return (
                      <button
                        key={file.file}
                        type="button"
                        className={`revert-file-tab${file.file === current?.file ? ' active' : ''}`}
                        onClick={() => setSelected(file.file)}
                        title={`${file.file}（+${file.additions} -${file.deletions}）`}
                      >
                        <span className={`review-mark ${mark.toLowerCase()}`}>{mark}</span>
                        {file.file}
                      </button>
                    )
                  })}
                </span>
              ) : null}
            </div>

            {error ? <div className="revert-error">{error}</div> : null}

            {current ? (
              <DiffBody key={`${activeID}:${current.file}`} patch={current.patch} wrap={wrap} />
            ) : error ? (
              <div className="revert-empty inner">
                换一个节点看看；也可以关掉面板直接用「回到上一版」
              </div>
            ) : (
              <div className="revert-empty inner">
                {loading ? '读取改动中…' : '这一轮只对话、没有改动文件'}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="revert-foot">
        <span className="revert-foot-hint">
          {busy
            ? '正在生成回复，先停止再回溯'
            : reverted
              ? '已经在回撤状态，先取消回撤或直接发送'
              : '回撤只回退文件，随时可以取消'}
        </span>
        <button
          type="button"
          className="revert-do"
          disabled={!canRevert}
          onClick={() => active && onRevert(active)}
        >
          {active ? `回到 #${active.index}` : '回到这一版'}
        </button>
      </div>
    </div>
  )
}
