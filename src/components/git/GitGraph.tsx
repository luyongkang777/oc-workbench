/**
 * 提交图形树（契约：docs/git-graph-contract.md §3）。
 *
 * 布局在 graphLayout 里算完（纯函数），这里只负责画：
 * 左侧 SVG —— 每条 lane 的三次贝塞尔连线 + 本行的提交点；
 * 右侧文字 —— 提交号 / refs 标签 / 说明，下面一行作者与相对时间。
 *
 * 图形列宽度按整张图的最大 lane 数定死，避免逐行宽度不同导致右侧文字左右跳。
 */
import { useMemo } from 'react'
import type { GitCommit } from '../../api/git'
import { relativeTime } from './gitFormat'
import { layoutGraph } from './graphLayout'
import type { GraphEdge, GraphRow } from './graphLayout'

type GitGraphProps = {
  commits: GitCommit[]
  head: string
  detached: boolean
  onRollback: (commit: GitCommit) => void
  /** 点击整行看这次提交的差异；现在还没接管，传了才让整行可点 */
  onOpenDiff?: (commit: GitCommit) => void
}

/* 布局常量写死（不读 CSS 变量）：SVG 几何不该被主题或用户样式改动 */
/** 行高 */
const ROW_H = 26
/** 单条 lane 的宽度 */
const LANE_W = 14
/** 图形列左侧留白 */
const PAD_L = 6
/** 提交点半径 */
const DOT_R = 3.5
/** 合并提交外环半径：比提交点大一圈，又不会碰到相邻 lane */
const MERGE_R = 6
/** 连线宽度 */
const EDGE_W = 1.5
/** 图形列右侧留白（宽度 = laneCount * LANE_W + GRAPH_PAD） */
const GRAPH_PAD = 12

/**
 * 6 色分支调色板：全部取语义 token，浅色主题自动跟着换，不出现硬编码 hex。
 * 顺序即颜色索引，同一条 lane 的索引稳定，所以同一条分支线颜色恒定。
 */
const PALETTE = [
  'var(--accent)',
  'var(--info)',
  'var(--reasoning)',
  'var(--success)',
  'var(--warn)',
  'var(--danger)',
]

/** lane 中心 x：左留白 + 半个 lane */
function laneX(lane: number): number {
  return PAD_L + LANE_W / 2 + lane * LANE_W
}

/** 颜色索引 → CSS 颜色（越界也安全） */
function paletteOf(color: number): string {
  const size = PALETTE.length
  const index = ((Math.trunc(color) % size) + size) % size
  return PALETTE[index]
}

/**
 * 进入本行的连线：从上一行的点 (x1, -ROW_H/2) 到本行的点 (x2, ROW_H/2)。
 * 高度取负值是因为每行一个独立 svg，上一行的点在视框之外（CSS 允许溢出）。
 */
function edgePath(edge: GraphEdge): string {
  const x1 = laneX(edge.from)
  const x2 = laneX(edge.to)
  const y1 = -ROW_H / 2
  const y2 = ROW_H / 2
  return `M ${x1} ${y1} C ${x1} ${y2} ${x2} ${y1} ${x2} ${y2}`
}

/**
 * 渲染侧要用的三个字段。类型上已由 `GitCommit` 保证（契约 §1），
 * 运行时仍按缺省值兜底：后端未升级时老响应里没有这三项，不能让整个图崩掉。
 */
type CommitExtra = { parents: string[]; refs: string[]; unpushed: boolean }

function extraOf(commit: GitCommit): CommitExtra {
  return {
    parents: commit.parents ?? [],
    refs: commit.refs ?? [],
    unpushed: commit.unpushed ?? false,
  }
}

type RefTone = 'head' | 'remote' | 'tag' | 'local'

/** 常见远程名；其余远程名由 `a/b` 里 b 是已知本地分支名推断出来 */
const DEFAULT_REMOTES = ['origin', 'upstream']

function isTagRef(ref: string): boolean {
  return ref.startsWith('tag:')
}

function isHeadRef(ref: string): boolean {
  return ref === 'HEAD' || /^HEAD\s*->/.test(ref)
}

/**
 * 推断远程名集合。
 *
 * 只靠 `origin/xxx` 会把 fork 或自定义远程漏掉，只靠「带斜杠就是远程」又会把
 * `feature/x` 这种本地分支误判。折中：默认认 origin / upstream；另外若 `a/b` 的
 * `b` 本身就是一个无斜杠的 ref（本地分支），那 `a` 也是远程名。
 */
function remotePrefixesOf(refs: string[]): Set<string> {
  const names = new Set(DEFAULT_REMOTES)
  const bare = new Set<string>()

  for (const ref of refs) {
    if (isTagRef(ref) || isHeadRef(ref)) continue
    if (!ref.includes('/')) bare.add(ref)
  }

  for (const ref of refs) {
    if (isTagRef(ref) || isHeadRef(ref)) continue
    const slash = ref.indexOf('/')
    if (slash <= 0) continue
    if (bare.has(ref.slice(slash + 1))) names.add(ref.slice(0, slash))
  }

  return names
}

function toneOf(ref: string, remotes: Set<string>): RefTone {
  if (isHeadRef(ref)) return 'head'
  if (isTagRef(ref)) return 'tag'
  const slash = ref.indexOf('/')
  if (slash > 0 && remotes.has(ref.slice(0, slash))) return 'remote'
  return 'local'
}

type GraphView = {
  items: { row: GraphRow; extra: CommitExtra }[]
  remotes: Set<string>
  graphW: number
  unpushed: number
  branchCount: number
  hasRemote: boolean
  headLabel: string
}

function buildView(commits: GitCommit[], head: string, detached: boolean): GraphView {
  const rows = layoutGraph(commits)
  const items = rows.map((row) => ({ row, extra: extraOf(row.commit) }))

  const allRefs: string[] = []
  for (const item of items) allRefs.push(...item.extra.refs)
  const remotes = remotePrefixesOf(allRefs)

  let laneCount = 1
  for (const row of rows) {
    if (row.laneCount > laneCount) laneCount = row.laneCount
  }

  let unpushed = 0
  let hasRemote = false
  const branches = new Set<string>()

  for (const item of items) {
    if (item.extra.unpushed) unpushed += 1
    for (const ref of item.extra.refs) {
      const tone = toneOf(ref, remotes)
      if (tone === 'head') {
        // `HEAD -> main` 本身就是分支 main 的证据，计数时把 `main` 算上
        const arrow = ref.indexOf('->')
        const name = arrow === -1 ? '' : ref.slice(arrow + 2).trim()
        if (name) branches.add(name)
      } else if (tone === 'remote') {
        hasRemote = true
        branches.add(ref)
      } else if (tone === 'local') {
        branches.add(ref)
      }
    }
  }

  return {
    items,
    remotes,
    graphW: laneCount * LANE_W + GRAPH_PAD,
    unpushed,
    branchCount: branches.size,
    hasRemote,
    headLabel: detached ? '游离 HEAD' : `当前分支 ${head || '未知'}`,
  }
}

export default function GitGraph({
  commits,
  head,
  detached,
  onRollback,
  onOpenDiff,
}: GitGraphProps) {
  const view = useMemo(() => buildView(commits, head, detached), [commits, head, detached])

  const summary = (
    <div className="git-graph-summary">
      <span>{view.headLabel}</span>
      <span>
        {view.unpushed > 0 ? `本地 ${view.unpushed} 个提交未推送` : '本地提交都已推送'}
      </span>
      <span>共 {view.branchCount} 个分支</span>
      {view.hasRemote ? null : <span className="git-graph-note">还没设置远程</span>}
    </div>
  )

  if (view.items.length === 0) {
    return (
      <div className="git-graph">
        {summary}
        <div className="git-graph-empty">还没有任何提交</div>
      </div>
    )
  }

  const clickable = onOpenDiff !== undefined

  return (
    <div className="git-graph">
      {summary}

      <div className="git-graph-scroll">
        {view.items.map(({ row, extra }) => {
          const color = paletteOf(row.color)
          const cx = laneX(row.lane)
          const cy = ROW_H / 2
          const merged = extra.parents.length > 1
          const time = relativeTime(row.commit.time)

          return (
            <div
              key={row.commit.hash}
              className={`git-graph-row${clickable ? ' clickable' : ''}`}
              onClick={clickable ? () => onOpenDiff?.(row.commit) : undefined}
              onKeyDown={
                clickable
                  ? (event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      onOpenDiff?.(row.commit)
                    }
                  : undefined
              }
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
            >
              <svg
                className="git-graph-svg"
                width={view.graphW}
                height={ROW_H}
                viewBox={`0 0 ${view.graphW} ${ROW_H}`}
                aria-hidden="true"
                focusable="false"
              >
                <g>
                  {row.edges.map((edge, index) => (
                    <path
                      key={`e-${edge.from}-${edge.to}-${index}`}
                      d={edgePath(edge)}
                      fill="none"
                      stroke={paletteOf(edge.color)}
                      strokeWidth={EDGE_W}
                      strokeLinecap="round"
                    />
                  ))}

                  {merged ? (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={MERGE_R}
                      fill="none"
                      stroke={color}
                      strokeWidth={EDGE_W}
                      opacity={0.55}
                    />
                  ) : null}

                  {extra.unpushed ? (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={DOT_R}
                      fill="var(--bg-1)"
                      stroke={color}
                      strokeWidth={2}
                    />
                  ) : (
                    <circle cx={cx} cy={cy} r={DOT_R} fill={color} />
                  )}
                </g>
              </svg>

              <div className="git-graph-main">
                <div className="git-graph-title">
                  <span className="git-graph-hash" title={row.commit.hash}>
                    {row.commit.short}
                  </span>
                  {extra.refs.map((ref, index) => {
                    const tone = toneOf(ref, view.remotes)
                    return (
                      <span
                        key={`${ref}-${index}`}
                        className={`git-graph-ref${tone === 'local' ? '' : ` ${tone}`}`}
                        title={ref}
                      >
                        {ref}
                      </span>
                    )
                  })}
                  <span className="git-graph-msg" title={row.commit.message}>
                    {row.commit.message || '（没有说明）'}
                  </span>
                </div>

                <div className="git-graph-meta">
                  <span>{row.commit.author || '未知作者'}</span>
                  {time ? <span>·</span> : null}
                  {time ? <span>{time}</span> : null}
                  {extra.unpushed ? <span className="git-graph-local">本地未推送</span> : null}
                </div>
              </div>

              <button
                type="button"
                className="git-graph-action"
                onClick={(event) => {
                  event.stopPropagation()
                  onRollback(row.commit)
                }}
              >
                回滚到这次
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
