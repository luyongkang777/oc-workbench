# 提交图形树契约

> 把「历史」页签从平面列表换成图形提交树：能看出分叉/合并、每个提交属于哪条分支、哪些提交还没推到远程。
> 数据来自 `git log --all`，布局由前端纯函数算，渲染用 SVG。

## 0. 为什么要 `--all`

现在 `git log -n 50` 只走当前分支，出来的永远是一条直线，画不出分叉，也看不出本地分支和远程分支的关系。
改成 `--all --date-order` 之后，所有本地分支 + 所有远程分支的提交都进同一个视图，合并点和分叉点自然出现，「本地领先远程几个提交」也变成肉眼可见的事。

## 1. 后端：扩展 `GET /local/git/log`

现有响应只有 `{ commits: [...] }`，要扩成：

```json
{
  "commits": [
    {
      "hash": "9f2a1c...",
      "short": "9f2a1c3",
      "parents": ["7b3d0a...", "1c4e9f..."],
      "message": "feat: 图形提交树",
      "author": "luyongkang777",
      "time": 1794520003,
      "isHead": true,
      "tags": ["v0.2"],
      "refs": ["HEAD -> main", "origin/main", "tag: v0.2"],
      "unpushed": true
    }
  ],
  "branches": [
    { "name": "main", "kind": "local", "hash": "9f2a1c..." },
    { "name": "origin/main", "kind": "remote", "hash": "7b3d0a..." },
    { "name": "v0.2", "kind": "tag", "hash": "9f2a1c..." }
  ],
  "head": "main",
  "detached": false
}
```

字段规则：

- **`parents`**：`git log --format=%P` 给出，空格分隔，空字符串（根提交）→ `[]`。顺序保持不变（第一个是主线父）。
- **`refs`**：`%D` 原始装饰串按 `, ` 切开、去掉只属于 `HEAD` 的那段后的数组；`HEAD -> main` 这种整段保留。同时**要去掉 `tag: ` 前缀放进 `tags`**，`refs` 里保留原始形式，前端好显示。没有装饰 → `[]`。
- **`unpushed`**：该提交是否不在任何远程分支上。计算方式：一次 `git rev-list --all --not --remotes` 拿全部未推送 hash（NUL 或换行分隔都行，自己 split），再用集合判断。**不要**对每个提交单独调 git。仓库没有远程时，所有提交都算 `unpushed: true`（这是事实：推不出去就等于没推）。
- **`branches`**：一次 `git for-each-ref --format=%(refname:short)%00%(objectname)%00%(refname) refs/heads refs/remotes refs/tags` 拿全。
  - `refs/heads/*` → `kind: "local"`
  - `refs/remotes/*` → `kind: "remote"`；**跳过 `origin/HEAD`**（它只是个符号引用，不是真分支）
  - `refs/tags/*` → `kind: "tag"`
- **`head`**：当前分支名；detached 时空串。`detached: true`。
- 日志参数：`git log --all --date-order -n <limit> --format=%H%x00%h%x00%P%x00%s%x00%an%x00%at%x00%D`，`limit` 默认 50、上限 200。
- 空仓库仍返回 `{ commits: [], branches: [], head: "", detached: false }`。
- 所有 git 调用保持 `-c core.quotepath=false` 在子命令之前、`-z`/`%x00` 分隔的既有约定。

dev（`scripts/dev-local-git.mjs`）和 Rust（`shell/src/gitapi.rs`）两份实现，**输出必须逐字段一致**。

## 2. 前端布局算法：`src/components/git/graphLayout.ts`

纯函数，不碰 React、不碰 DOM。

```ts
export type GraphEdge = {
  from: number   // 上一行所在 lane
  to: number     // 本行所在 lane
  color: number  // 颜色索引（取 lane 的稳定值）
}

export type GraphRow = {
  commit: GitCommit
  lane: number       // 本提交占用的 lane（0 起）
  color: number      // 本提交点的颜色索引
  edges: GraphEdge[] // 从上一行进入本行的所有连线
  laneCount: number  // 本行需要画的最大 lane 数（含右侧空 lane，用来定 SVG 宽度）
}

export function layoutGraph(commits: GitCommit[]): GraphRow[]
```

算法（照这个写，别自由发挥，否则图形会乱）：

```
lanes: (string|null)[] = []   // 每条 lane 正在等的下一个 commit hash
prev:  (string|null)[] = []   // 上一行结束时的 lanes 快照
rows = []

for commit of commits:
  // 1. 本提交落在哪条 lane
  lane = lanes.indexOf(commit.hash)
  if lane === -1:
    lane = lanes.indexOf(null)          // 有空位就复用
    if lane === -1: lane = lanes.length; lanes.push(null)

  // 2. 连线：上一行每个还在等的 hash，看它跑到哪条 lane 了
  edges = []
  for (i = 0; i < prev.length; i++):
    h = prev[i]; if (!h) continue
    if (h === commit.hash):
      // 这条 lane 在本行被消费掉了 → 连到本提交的 lane
      edges.push({ from: i, to: lane, color: i })
    else:
      j = lanes.indexOf(h)               // 本行里还在等它
      if (j !== -1) edges.push({ from: i, to: j, color: i })
      // 找不到就说明被合并吃掉了，不画线

  // 3. 更新 lanes：本 lane 换成第一个父
  parents = commit.parents
  lanes[lane] = parents[0] ?? null

  // 4. 其余父（合并提交）：找它已存在的 lane，否则占一个空位（不要 splice 挤开别人）
  for (p of parents.slice(1)):
    if (lanes.includes(p)) continue      // 已经在等它了，不重复开 lane
    slot = lanes.indexOf(null)
    if (slot === -1): slot = lanes.length; lanes.push(null)
    lanes[slot] = p

  // 5. 去掉尾部连续 null，避免右侧无意义的空白
  while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()

  rows.push({ commit, lane, color: lane, edges, laneCount: Math.max(lanes.length, lane + 1) })
  prev = [...lanes]
```

补充约定：
- 颜色索引用 `lane % PALETTE_SIZE`（`PALETTE_SIZE = 6`），**不要**按 hash 随机取色——同一条分支线颜色必须一致。
- 输出顺序与输入一致（git 已经排好，`--date-order` 保证父在子之后）。
- 输入空数组 → 返回 `[]`，不抛错。
- 父提交不在 `commits` 里（超出 limit 被截断）→ 正常处理成 `null`，不报错。

## 3. 渲染：`src/components/git/GitGraph.tsx`

```ts
type GitGraphProps = {
  commits: GitCommit[]
  head: string
  detached: boolean
  onRollback: (commit: GitCommit) => void
  onOpenDiff?: (commit: GitCommit) => void   // 先留空实现
}
```

布局常量（写死，别读 CSS 变量）：
- 行高 `26px`，lane 宽 `14px`，左侧留白 `6px`
- 提交点半径 `3.5px`
- 图形区域宽度 = `laneCount * 14 + 12`

视觉规则：
- **已推送**：实心圆（`fill: 分支色`）
- **未推送**：空心圆（`fill: 面板底色` + `stroke: 分支色` + `stroke-width: 2`）—— 一眼就能看出哪些还在本地
- **合并提交**（`parents.length > 1`）：圆再套一个稍大的描边环
- 连线：`path` 用三次贝塞尔 `M x1 y1 C x1 y2 x2 y1 x2 y2`，`stroke-width: 1.5`，颜色按 edge.color 取调色板
- 调色板 6 色，全部从现有 CSS 语义变量取，没有就用面板已有的强调色 / 成功色 / 警告色 / 危险色 + 两个中性色；**不要硬编码 hex**，用 `var(--...)`

右侧每行内容：
- 第一行：`short`（等宽字体，次要色）+ refs 标签（`HEAD -> main` 高亮、`origin/*` 用冷色、`tag:` 用暖色）+ 提交说明（单行省略）
- 第二行：作者 · 相对时间 · 「本地未推送」标记（仅 `unpushed` 时显示，暖色小标签）
- 行尾 hover 才显示的「回滚到这次」按钮（保持原有能力）
- 点击整行 → `onOpenDiff?.(commit)`（现在不实现也行，先留占位）

顶部（在树之上，属于历史页签内部）：
- 一行摘要：`当前分支 main`、`本地 N 个提交未推送`、`共 M 个分支`
- 没有远程时显示「还没设置远程」

空态：`还没有任何提交`。

## 4. 接进 `GitPanel.tsx`

- 历史页签的内容整体换成 `<GitGraph ... />`，删掉原来的平面列表渲染（`git-commit-row` / `git-commit-hash` / `git-commit-main` / `git-commit-msg` / `git-commit-meta` / `git-rollback`）。
- 回滚确认层保留不动：`GitGraph` 的 `onRollback` 接到现有的 `setRolling(commit)`。
- 历史数据加载改成拿新结构：`loadHistory` 要同时保存 `commits` / `branches` / `head` / `detached`。
- 加载更多：底部一个「加载更多」，每次 `limit += 50`（上限 200），点了重新拉。没提交可加时隐藏。

## 5. 样式

追加到 `src/styles/git.css`（只追加不改现有）：`git-graph`、`git-graph-summary`、`git-graph-scroll`、`git-graph-row`、`git-graph-svg`、`git-graph-main`、`git-graph-title`、`git-graph-meta`、`git-graph-ref`、`git-graph-ref.head`、`git-graph-ref.remote`、`git-graph-ref.tag`、`git-graph-local`、`git-graph-action`、`git-graph-more`、`git-graph-empty`。

## 6. 测试

- 布局算法必须有 `scripts/graphLayout.test.mjs`，至少覆盖：
  - 直线（单分支 3 个提交）→ 每行 lane 0，无边
  - 分叉再合并（菱形）→ 合并没有重复 lane，edges 能连回
  - 两个并行分支 → lane 0 / lane 1，互不串色
  - 根提交（`parents: []`）→ 不崩
  - 父提交不在列表里 → 不崩
  - 空数组 → `[]`
  - 空位复用：分支结束后新分支能占回 lane 0
- 后端：dev 侧 `scripts/gitops.test.mjs` 追加用例（临时仓库造出「两个分支 + 一个合并」），断言 `parents` / `unpushed` / `branches` / `head` 正确；Rust 侧 `#[cfg(test)]` 测解析函数。
