# Git 面板接口契约（唯一真相）

> 极简中文化 Git：**只做**初始化 / 状态 / 提交 / push / 回滚 / 排除（.gitignore）。
> **不做**分支管理、合并、rebase、子模块、stash、cherry-pick。api 里不出现这些词。

## 0. 通用约定

- 路由前缀 `/local/git/`，与 `/local/fs/*` 同级：dev 由 Vite 中间件实现，生产由 Rust 外壳实现，行为必须一致。
- 认证：`/local/*` 已经在 `server.rs` 里统一做了 `x-oc-token` 校验，新路由不再自己校验。
- `root` 一律是**绝对路径**（`F:\opencode\workbench`）。`path` / `paths` 一律是**相对 root** 的路径，分隔符统一用 `\`（Windows 风格），入参接受 `/` 或 `\`。
- 所有 git 子进程调用必须带 `-c core.quotepath=false`（**放在子命令之前**，例如 `git -c core.quotepath=false status ...`），否则中文文件名会变成 `\344\270\255` 八进制转义。
- 状态类输出统一用 `-z`（NUL 分隔）解析，避免空格 / 中文 / 引号把解析搞崩。
- 出错统一返回 `{ error: string, status: number }` + 对应 HTTP 状态码。错误文案直接给中文，且**直接透传 git 的 stderr**（用户要能看到真正的失败原因）。
- POST 请求体是 JSON（`content-type: application/json`），读取上限 1MB。
- 超时：status / log / tree / ignore / discard 30s；init / commit 60s；push 180s。
- 仓库不可用（没装 git、目录不存在）→ 400 + 「找不到 git 命令」/「目录不存在」。

## 1. 数据结构

```ts
export type GitChange =
  | 'added' | 'modified' | 'deleted' | 'untracked' | 'renamed' | 'conflicted'

export type GitFile = {
  path: string              // 相对 root
  status: GitChange
  staged: boolean           // 是否已进暂存区（index）
  worktreeDirty: boolean    // 已暂存但同时工作区又有新改动（porcelain 的 MM/AM）
  renamedFrom?: string      // 仅 renamed 有
}

export type GitCommit = {
  hash: string              // 完整 40 位
  short: string             // 前 7 位
  message: string           // 第一行（subject）
  author: string
  time: number              // Unix 秒
  isHead: boolean           // 是否当前 HEAD
  tags: string[]            // refs 里的 tag 名（没有就空数组）
}
```

## 2. 接口

### GET `/local/git/status?root=ABS`

只有一个接口，未初始化也必须 200 返回（`initialized:false`），前端靠它决定显示「一键初始化」还是正常面板。

```json
{
  "initialized": true,
  "branch": "main",
  "remote": "https://github.com/me/repo.git",
  "upstream": "origin/main",
  "ahead": 2,
  "behind": 0,
  "detached": false,
  "files": [ { "path": "src\\a.ts", "status": "modified", "staged": false, "worktreeDirty": false } ],
  "lastCommit": { "hash": "...", "short": "...", "message": "初始化", "author": "me", "time": 1712345678 },
  "gitignore": ["node_modules/", "dist/"]
}
```

- `initialized:false` 时其余字段：`branch:""`、`remote:""`、`upstream:""`、`ahead:0`、`behind:0`、`detached:false`、`files:[]`、`lastCommit:null`、`gitignore:[]`。**不要**报错。
- `remote` 取 `origin` 的 url（没有 origin 就空串）。`ahead`/`behind` 是相对 `upstream`；没有 upstream 时都是 0，并额外给 `"noUpstream": true`。
- `gitignore` 是 `.gitignore` 的有效行（去掉空行和 `#` 注释，保留原样，含结尾 `/`）。
- 解析 porcelain v1：X=index 状态，Y=工作区状态。`??`→untracked/staged:false。`R` 取 `->` 后的新路径并带 `renamedFrom`。`UU/AA/DD`→conflicted。X 非空且非 `?` → staged:true；X 与 Y 同时非空且不是 `??` → worktreeDirty:true。

### POST `/local/git/init?root=ABS`

一键初始化。执行 `git init -b main`（git ≥2.28 支持 `-b`；失败则退回 `git init` + `git symbolic-ref HEAD refs/heads/main`）。

- 已经是仓库 → 不报错，直接 `{ ok:true, branch:"当前分支", alreadyInitialized:true }`。
- 会顺手写一份基础 `.gitignore`（只在文件不存在时创建），内容按行：`node_modules/`、`dist/`、`.tmp/`、`*.log`、`.DS_Store`、`target/`、`.vite/`。
- 返回 `{ ok:true, branch:"main", alreadyInitialized:false }`。

### POST `/local/git/commit?root=ABS`

body：
```json
{ "message": "提交说明", "paths": ["src\\a.ts"] }
```
- `paths` 省略或空数组 → 暂存全部（`git add -A`），然后 `git commit -m <message>`。
- `paths` 非空 → 只 `git add -- <paths...>`（`-A` 语义，能带上删除），然后 `git commit -m <message> -- <paths...>`。
- message 去掉首尾空白后为空 → 400「提交说明不能为空」。
- 暂存后没有任何改动 → 409「没有可提交的改动」（不要执行 commit 让 git 报一堆英文）。
- 成功 → `{ ok:true, hash, short, count }`（count = 本次提交涉及的文件数，用提交后的 `git show --name-only --format=` 数）。

### POST `/local/git/push?root=ABS`

body 可选 `{ "setUpstream": true }`（默认 true）。

- 没有 `origin` → 400「还没设置远程仓库，先填一个地址」。
- 没有 upstream → `git push -u origin <branch>`；否则 `git push`。
- 成功 → `{ ok:true, branch:"main", output:"git 的原始 stdout+stderr（截断到 4000 字符）" }`。
- 失败 → 502，`error` 里带 git 的 stderr（常见：认证失败 / 非快进 / 网络不通）。**不要**吞掉原文。

### GET `/local/git/log?root=ABS&limit=50`

`git log -n <limit> --format=...`，limit 默认 50，上限 500。

```json
{ "commits": [ { "hash":"...", "short":"...", "message":"...", "author":"...", "time":1712345678, "isHead":true, "tags":[] } ] }
```

- 格式串用 `%H%x00%h%x00%s%x00%an%x00%at%x00%D`，每条一行，字段用 `\x00` 分隔，避免 `%s` 里出现分隔符。
- 空仓库（还没有提交）→ `{ "commits": [] }`，不报错。

### POST `/local/git/rollback?root=ABS`

body：
```json
{ "hash": "abc1234", "mode": "soft" }
```
- `mode` 只有 `"soft"`（默认，保留改动到工作区）和 `"hard"`（连工作区一起丢弃）。
- 执行 `git reset --soft <hash>` / `git reset --hard <hash>`。
- hash 必须能在 `git rev-parse --verify <hash>^{commit}` 里解析出来，否则 400「找不到这个提交」。
- 成功 → `{ ok:true, hash, mode, branch }`。
- **注意**：hard 会丢改动，危险确认由前端做，后端不二次询问。

### POST `/local/git/discard?root=ABS`

撤销工作区里某些文件/目录的改动（历史里不出现，只是丢本地修改）。

body `{ "paths": ["src\\a.ts", "dist\\"] }`

- 每条先 `git restore --source=HEAD --staged --worktree -- <path>`；如果该路径是**未跟踪**（git restore 会失败），就删掉它（文件删文件、目录删目录）。
- 成功 → `{ ok:true, count }`。

### GET `/local/git/tree?root=ABS&path=REL`

给拖拽排除用的目录列表。`path` 省略 = 根目录。

```json
{ "entries": [ { "path": "src", "name": "src", "type": "directory", "ignored": true }, { "path": "README.md", "name": "README.md", "type": "file", "ignored": false } ] }
```

- 目录在前、按名字排序（与 `/local/fs/list` 一致）。
- `ignored` 用 `git check-ignore --stdin -z` **一次批量**判断（拿 ignore 规则，不要求仓库已初始化；未初始化时全部 false）。
- **必须排除** `.git` 目录本身，以及 `node_modules`、`dist`、`target`、`.vite` 这些重目录里**不再往下展开**（列到上一级就够，用户要排除整个目录）。
- 路径越界（`..`）→ 400。

### POST `/local/git/ignore?root=ABS`

body：
```json
{ "paths": ["node_modules", "src\\secret.ts"], "action": "add" }
```

- `action: "add"`：把每条转成 gitignore 规则 —— 目录（路径以 `\`/`/` 结尾，或磁盘上确实是目录）→ `<相对路径>/`；文件 → `<相对路径>`。已存在的规则不重复写。追加到 `.gitignore` 末尾（文件末尾无换行时先补一个）。
- **关键**：如果这条路径当前已被 git 跟踪，还要 `git rm -r --cached -- <path>`，否则光写 .gitignore 不生效。未跟踪则跳过。
- `action: "remove"`：把匹配的行从 `.gitignore` 里删掉（精确匹配 `path` 和 `path/` 两种形式）。
- 返回 `{ ok:true, gitignore: ["..."] }`（写入后的完整有效行列表）。

### POST `/local/git/remote?root=ABS`

body `{ "url": "git@github.com:me/repo.git" }`

- url 为空 → 删除 origin（`git remote remove origin`，不存在就忽略）。
- 否则 `git remote add origin <url>`，已存在则 `git remote set-url origin <url>`。
- 校验 url 形态（`https://`、`http://`、`git@host:`、`ssh://`、本地路径 `/` 或盘符开头），不合法 → 400「远程地址看起来不对」。
- 返回 `{ ok:true, remote: "..." }`。

## 3. 前端组件契约

```tsx
// src/components/GitPanel.tsx
type GitPanelProps = {
  root: string                    // 绝对路径
  open: boolean
  onClose: () => void
  onOpenFile: (relPath: string) => void
}
export default function GitPanel(props: GitPanelProps): JSX.Element
```

行为要求：
- `open === false` 时不渲染任何东西（不要留在 DOM 里吃事件）。
- 打开时立刻拉 `status`，之后 5 秒轮询一次（面板关闭就停）。
- 未初始化 → 一个大按钮「初始化 Git 仓库」，点了走 `init` 再刷新。
- 已初始化 → 顶部状态条（分支名 / 远程 / 领先落后 / 上次提交），中间两段：**改动列表**（点击文件名走 `onOpenFile`）与**提交区**（多行输入 + 「提交」按钮），底部两个动作：「推送到远程」「历史」。
- 「历史」展开为提交列表，每行右侧一个「回滚到这次」，点开确认框（说明 soft 保留改动 / hard 丢弃改动），确认后调 `rollback`。
- 「排除」页签：文件树（走 `tree` 接口），每个条目右侧一个「排除」按钮；**整个页签是 drop zone** —— 从资源管理器（FileTree）拖进来的条目落在上面就等同点「排除」。同时支持多选后批量排除。
- 顶部状态条里有个铅笔图标能改远程地址（`remote` 接口）。
- 所有请求失败 → 顶部一条红色提示条，文案直接用后端返回的 `error`（已经是中文）。
- 全中文文案，不出现 branch/commit/push 之类的英文单词（远程地址、分支名本身除外）。

## 4. FileTree 拖拽契约

- 文件树每个节点（文件与目录）都是 `draggable`。
- `dragstart` 时 `e.dataTransfer.setData('application/x-oc-path', relPath)`，并 `effectAllowed = 'copyMove'`。
- 目录的 relPath 带结尾分隔符（`src\`），文件不带。
- 拖拽时给节点加 `dragging` class（半透明），`dragend` 移除。
- 不影响现有单击/双击/右键行为。
