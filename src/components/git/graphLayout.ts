/**
 * 提交图形树的布局：纯函数，不碰 React、不碰 DOM、不发请求。
 *
 * 契约见 docs/git-graph-contract.md §2，算法与那里的伪码逐行对应，
 * 只有「同一个 hash 被多条 lane 同时等待」时多做了一步收敛清理，
 * 理由写在下方第 4.5 步的注释里。
 */
import type { GitCommit } from '../../api/git'

/** 调色板容量。颜色索引一律取 `lane % PALETTE_SIZE`，保证同一条分支线颜色稳定。 */
export const PALETTE_SIZE = 6

/** 一条从上一行连进本行的线。 */
export type GraphEdge = {
  /** 上一行所在 lane */
  from: number
  /** 本行所在 lane */
  to: number
  /** 颜色索引，取 `from % PALETTE_SIZE` */
  color: number
}

/** 一行：一个提交 + 它在图上占的位置 + 进入这行的连线。 */
export type GraphRow = {
  commit: GitCommit
  /** 本提交占用的 lane（0 起） */
  lane: number
  /** 本提交点的颜色索引，取 `lane % PALETTE_SIZE` */
  color: number
  /** 从上一行进入本行的所有连线 */
  edges: GraphEdge[]
  /** 本行需要画的最大 lane 数（含右侧空 lane，用来定 SVG 宽度） */
  laneCount: number
}

/** 一条 lane 上记的是「它正在等的下一个 commit hash」，null 表示空位。 */
type Lane = string | null

/**
 * 一次性算出整棵树的布局。
 *
 * 输入顺序就是渲染顺序：git `--date-order` 已保证父在子之后，
 * 这里不排序、不去重、不按 hash 建索引，只做一遍线性扫描。
 * 空数组返回空数组；父提交被 limit 截断时它留在 lane 上一直等不到，
 * 表现为一条通向列表外的线，不影响其余行。
 */
export function layoutGraph(commits: GitCommit[]): GraphRow[] {
  if (!commits || commits.length === 0) return []

  const rows: GraphRow[] = []
  let lanes: Lane[] = []
  // 上一行结束时的 lanes 快照。连线是「快照 vs 本行」比出来的，
  // 不是拿父子关系直接连——合并提交那几行全靠这个差值才连得对。
  let prev: Lane[] = []
  // 上一行因为合并提交新开出来的 lane：那条线必须从「开出它的提交」斜过来，
  // 否则分支会像凭空从上方悬下来。挂到下一行再画。
  let pending: GraphEdge[] = []

  for (const commit of commits) {
    // 1. 本提交落在哪条 lane：优先复用已经在等它的那条，其次找空位，最后往右新开。
    let lane = lanes.indexOf(commit.hash)
    if (lane === -1) {
      lane = lanes.indexOf(null)
      if (lane === -1) {
        lane = lanes.length
        lanes.push(null)
      }
    }

    // 2. 连线：上一行每条还在等的 hash，看它在本行跑到哪条 lane。
    //    上一行挂过来的分叉线先接上，它替代掉「同一 to lane 的竖线」——
    //    那条 lane 是刚刚才开出来的，不存在从更上层一路直下的历史。
    const carried = pending
    pending = []
    const carriedTo = new Set(carried.map((edge) => edge.to))
    const edges: GraphEdge[] = []
    for (let i = 0; i < prev.length; i += 1) {
      const h = prev[i]
      if (!h) continue
      if (h === commit.hash) {
        // 这条 lane 等的就是本提交 → 连到本提交的 lane（分支汇合点）
        edges.push({ from: i, to: lane, color: i % PALETTE_SIZE })
      } else {
        // 还在等别的提交：它本行在哪条 lane 就画一条直线或斜线；
        // 找不到说明它被某次合并吃掉了，不画。
        const j = lanes.indexOf(h)
        if (j === -1) continue
        if (carriedTo.has(j)) continue
        edges.push({ from: i, to: j, color: i % PALETTE_SIZE })
      }
    }
    edges.push(...carried)

    // 后端字段缺失时（旧数据 / 空仓库）当根提交处理，不让布局抛错。
    const parents = Array.isArray(commit.parents) ? commit.parents : []

    // 3. 本 lane 换成第一个父：主线继续往前走。
    lanes[lane] = parents[0] ?? null

    // 4. 其余父（合并提交）：已经在等它就复用那条 lane，
    //    否则占一个空位。这里绝不 splice——挤开别的 lane 会让整棵树错位。
    //    新开的 lane 记一条挂起边：下一行要从本提交的位置斜过去连上它。
    for (const p of parents.slice(1)) {
      if (lanes.includes(p)) continue
      let slot = lanes.indexOf(null)
      if (slot === -1) {
        slot = lanes.length
        lanes.push(null)
      }
      lanes[slot] = p
      pending.push({ from: lane, to: slot, color: lane % PALETTE_SIZE })
    }

    // 4.5 收敛清理：同一行里可能有多条 lane 在等本提交（两个分支指向同一个父，
    //     或者一个合并提交的父已经在别处等着）。本提交已经把它们的线收进来了，
    //     这些 lane 之后再也不会被消费，留着会在右侧画出一条永不结束的竖线。
    //     只清「等于本提交 hash」的其它 lane，不动顺序、不合并索引。
    for (let i = 0; i < lanes.length; i += 1) {
      if (i !== lane && lanes[i] === commit.hash) lanes[i] = null
    }

    // 5. 裁掉尾部连续 null：不裁的话 SVG 右侧会留一大片空白。
    //    中间的空位不能裁——那是给后面分支复用的。
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()

    rows.push({
      commit,
      lane,
      color: lane % PALETTE_SIZE,
      edges,
      laneCount: Math.max(lanes.length, lane + 1),
    })
    prev = [...lanes]
  }

  return rows
}
