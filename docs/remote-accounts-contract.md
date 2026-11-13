# 远程账号与仓库托管接口契约

> 目标：面板里不用手抄 clone 地址。支持 GitHub（含自建）和 Gitea：填一次 token，之后能列出账号下所有仓库、也能现场建一个新仓库。
>
> **必须走后端代理**，不能让浏览器直连：
> 1. Gitea 默认 `[cors] ENABLE = false`，浏览器 fetch 会被 CORS 挡死；
> 2. 外壳是 http://127.0.0.1:随机端口，一些托管站会拒非 https 的 Referer；
> 3. token 不该出现在页面内存里被 XSS 拿走。

## 0. 通用

- 路由前缀 `/local/remote/`，与 `/local/fs/*`、`/local/git/*` 同级；dev 由 Vite 中间件实现，生产由 Rust 外壳实现，**行为必须一致**。
- `x-oc-token` 校验已在 `server.rs` 统一做，新路由不重复做。
- POST body 是 JSON，上限 256 KB。
- 错误统一 `{ error: string, status: number }`，`error` 用中文，且带上游返回的原因（能拿到就用上游 message）。
- 超时：accounts 读写 10s；probe / repos / create 走网络，给 25s。
- **所有网络请求必须能连 https**（GitHub）。Rust 侧要给 ureq 开 TLS feature（见 §5）。

## 1. 存储

文件：`%LOCALAPPDATA%\oc-workbench\remotes.json`（与 `projects.json` 同目录，**绝不能写进项目仓库**）。

```json
[
  {
    "id": "rm-1a2b3c4d",
    "kind": "gitea",
    "baseUrl": "http://192.168.31.8:3000",
    "apiBase": "http://192.168.31.8:3000/api/v1",
    "webUrl": "http://192.168.31.8:3000",
    "username": "luyongkang777",
    "token": "xxxxxxxx",
    "createdAt": 1794518769903
  }
]
```

- `id`：`rm-` + 8 位十六进制随机串。同名账号（同 kind + 同 apiBase + 同 username）**更新**而不是新增。
- 文件不存在 = 空数组，不报错。
- 写入用「临时文件 + rename」原子替换，别写一半把已有账号弄丢。
- `kind` 只有 `"github"` / `"gitea"`。
- 读接口**永远不回传 token**，只回 `hasToken: true`。

## 2. 接口

### GET `/local/remote/accounts`

```json
{ "accounts": [ { "id": "rm-1a2b3c4d", "kind": "gitea", "baseUrl": "http://192.168.31.8:3000", "webUrl": "http://192.168.31.8:3000", "username": "luyongkang777", "hasToken": true, "createdAt": 1794518769903 } ] }
```

### POST `/local/remote/accounts`

body：
```json
{ "kind": "gitea", "baseUrl": "http://192.168.31.8:3000", "token": "xxx", "username": "", "apiBase": "" }
```

- `baseUrl` 必填，去掉结尾 `/`。
- `apiBase` 空则由 `kind` 推：
  - github + baseUrl 是 `https://github.com` → `https://api.github.com`
  - github + 其他（GitHub Enterprise）→ `<baseUrl>/api/v3`
  - gitea → `<baseUrl>/api/v1`
- `token` 必填，去首尾空白。
- `username` 空的话，后端调一次 `/user` 拿 `login` 填上（复用 probe 逻辑）。
- 成功 → `{ "account": { ...同列表项... } }`（同样不含 token）。
- 同 kind + apiBase + username 已存在 → 更新 token 与 createdAt。

### DELETE `/local/remote/accounts?id=rm-1a2b3c4d`

- 成功 → `{ "ok": true }`；id 不存在 → 404「没有这个账号」。

### POST `/local/remote/probe`

添加账号前先验一次，避免存了个错 token。

body `{ "baseUrl": "http://192.168.31.8:3000", "token": "xxx", "kind": "" }`

- `kind` 为空时自动探测：
  1. `baseUrl` 含 `github.com` → `github`
  2. 否则 `GET <baseUrl>/api/v1/version`，200 且 body 有 `version` → `gitea`
  3. 都不中 → 400「认不出这是 GitHub 还是 Gitea」
- 用探测出的 kind 调 `/user` 验证 token：
  - github：`GET https://api.github.com/user`
  - gitea：`GET <apiBase>/user`
- 认证头统一 `Authorization: token <token>`（GitHub 和 Gitea 都接受这个前缀）。
- 也接受 `Bearer`？不用，统一 token 前缀，少一个分支。
- 成功 → `{ "kind": "gitea", "webUrl": "http://192.168.31.8:3000", "apiBase": "...", "username": "luyongkang777", "name": "显示名（有就带上）" }`
- token 无效 → 401，`error` 用上游 message（GitHub 是「Bad credentials」，Gitea 是「token is required」之类），前面补一句中文。

### GET `/local/remote/repos?account=rm-1a2b3c4d&q=&limit=100`

列出该账号可见的仓库（自己的 + 协作的），按最近更新排序。

- github：`GET https://api.github.com/user/repos?per_page=<limit>&sort=updated&affiliation=owner,collaborator,organization_member`
- gitea：`GET <apiBase>/user/repos?limit=<limit>&page=1`
- `q` 非空时**由后端本地过滤**（`full_name` 大小写不敏感包含），不要依赖各站搜索参数的不一致。

```json
{ "repos": [ {
  "fullName": "luyongkang777/oc-workbench",
  "name": "oc-workbench",
  "owner": "luyongkang777",
  "private": false,
  "cloneUrl": "http://192.168.31.8:3000/luyongkang777/oc-workbench.git",
  "sshUrl": "git@192.168.31.8:luyongkang777/oc-workbench.git",
  "defaultBranch": "main",
  "updatedAt": 1794518769,
  "empty": false
} ] }
```

- `cloneUrl`：优先用站点返回的 `clone_url`；gitea 的 `clone_url` 就是 http 地址。
- `sshUrl`：用站点返回的 `ssh_url`。
- `empty`：GitHub 用 `size === 0`；Gitea 用 `empty === true`（没有就按 `size === 0`）。**空的远程仓库对用户最有价值**（首推不会冲突），前端要标出来并排前面。
- 拿不到 `ssh_url` 就空串。

### POST `/local/remote/create`

body `{ "account": "rm-1a2b3c4d", "name": "oc-workbench", "private": false, "description": "" }`

- 名字校验：`^[A-Za-z0-9._-]{1,100}$`，不合法 → 400「仓库名只能用字母、数字、点、下划线、短横线」。
- github：`POST https://api.github.com/user/repos` body `{ "name", "private", "description", "auto_init": false }`
- gitea：`POST <apiBase>/user/repos` body `{ "name", "private", "description", "auto_init": false }`
- **必须 `auto_init: false`**，否则远端带一次初始提交，本地首推会被拒（non-fast-forward）。
- 成功 → `{ "repo": { ...同 repos 项... } }`
- 仓库已存在 → 409，`error` 带上游原文。

## 3. 前端

### 3.1 `src/api/remote.ts`

```ts
export type RemoteKind = 'github' | 'gitea'
export type RemoteAccount = { id: string; kind: RemoteKind; baseUrl: string; webUrl: string; username: string; hasToken: boolean; createdAt: number }
export type RemoteRepo = { fullName: string; name: string; owner: string; private: boolean; cloneUrl: string; sshUrl: string; defaultBranch: string; updatedAt: number; empty: boolean }
```

函数：`listAccounts` / `saveAccount` / `deleteAccount` / `probeHost` / `listRemoteRepos` / `createRemoteRepo`。
全部走 `client.ts` 的 `localRequest`；probe / repos / create 传 `25_000` 超时。

### 3.2 `src/components/git/RemotePicker.tsx`

`export default function RemotePicker(props)`：

```ts
type Props = {
  root: string
  open: boolean
  current: string                 // 当前 remote 地址（可能为空）
  onPick: (url: string) => void   // 选定后回调，父组件负责 setRemote
  onClose: () => void
}
```

- `open === false` → `return null`。
- 覆盖层（`position: absolute; inset: 0`，与 `git-confirm-layer` 同一套视觉），卡片居中，宽度 100% 减 24px。
- 三个页签：
  - **手动填写**：一个 input（初值 `current`）+ 「使用这个地址」按钮。原有能力不能丢。
  - **选已有仓库**：顶部账号下拉（`listAccounts`）；没账号时显示「还没有添加账号」+ 一个「添加账号」按钮。有账号时列出仓库（`listRemoteRepos`），带搜索框（本地过滤也交给后端 `q`）。每行：`fullName`、私有/空仓库标签、右侧「用这个」。空仓库加 `git-repo-empty` 标记并排在最前。
  - **新建仓库**：仓库名输入（默认取 root 目录名，小写化、非 `[A-Za-z0-9._-]` 换成 `-`）、私有勾选框、描述（可选）、「创建并使用」按钮。
- 三个页签顶部固定一行「账号」区域：下拉选账号 + 「添加账号」按钮；没有账号时三个页签里除了「手动填写」都提示先去添加。
- 添加账号用一个二级卡片（不跳页）：选 GitHub / Gitea（或留「自动识别」）→ 服务器地址（GitHub 固定 `https://github.com`，Gitea 填根地址）→ token 输入 → 「验证并保存」→ 调 `probeHost` 成功后 `saveAccount`。
- token 输入框要 `type="password"`，旁边一个「显示」切换。
- token 获取途径写一句小字提示：
  - GitHub：「Settings → Developer settings → Personal access tokens → 勾 repo」
  - Gitea：「设置 → 应用 → 生成令牌 → 勾 repository」
- 取消账号 / 删除账号：账号行右侧一个「删除」，二次确认后 `deleteAccount`。
- 所有回调成功后调 `onPick(url)` 并 `onClose()`。

### 3.3 接进 `GitPanel.tsx`

- 把现在的「设置远程」内联输入行，改成打开 `RemotePicker`（保留 `git-remote-form` 那条路径作为 Picker 里的「手动填写」，不要两套并存）。
- `onPick` → `setRemote(root, url)` → `load(true)`。
- 新增状态：`remotePickerOpen`。
- **不要**在 GitPanel 里再实现一遍账号逻辑。

## 4. 样式

`src/styles/git.css` 追加（类名统一 `git-` 前缀）：`git-picker-layer`、`git-picker-card`、`git-picker-tabs`、`git-picker-tab`、`git-picker-body`、`git-picker-row`、`git-account-bar`、`git-account-select`、`git-account-add`、`git-account-del`、`git-repo-list`、`git-repo-row`、`git-repo-name`、`git-repo-tag`、`git-repo-empty`、`git-repo-use`、`git-form-row`、`git-form-label`、`git-form-input`、`git-token-row`、`git-token-toggle`、`git-form-hint`、`git-form-error`。

## 5. Rust 侧 TLS

`shell/Cargo.toml` 现在是：

```toml
ureq = { version = "2", default-features = false }
```

Android/wry 那套不受影响，但 **`ureq` 没有 TLS 就连不了 https**。改成：

```toml
ureq = { version = "2", default-features = false, features = ["native-tls", "json"] }
```

- 选 `native-tls` 而不是 `tls`（rustls）：Windows 上走系统 Schannel，不用打包根证书，编译体积和首次编译时间都小。
- 改完必须跑 `cargo build --release`（不只是 check），确认 TLS 后端真的链进来了。
- 网络失败要把原因翻译成人话：连不上写「连不上 <host>，检查地址和网络」，证书错误写「证书校验失败」，401 写「token 无效或已过期」，404 写「接口不存在，确认是 Gitea 而不是别的服务」。

## 6. 测试要求

- dev 侧：`scripts/remoteAccounts.test.mjs`
  - 账号存/读/删/去重（同名更新不是新增）
  - token 不回传
  - 仓库名校验
  - `apiBase` 推导（github.com / GHE / gitea）
  - `empty` 判定与排序
  - 用本地起一个假 HTTP 服务模拟 Gitea（`/api/v1/version`、`/api/v1/user`、`/api/v1/user/repos`），跑通 probe / repos / create 三条链路，**不要连真站**
- Rust 侧：`remoteapi.rs` 里 `#[cfg(test)]` 测纯函数（apiBase 推导、仓库名校验、JSON 映射、空仓库判定），网络部分不做单测。
- 前端：`scripts/remotePicker.test.mjs` 测纯函数（默认仓库名生成、仓库排序：空仓库优先 + 按 updatedAt 倒序、账号显示文案）。
