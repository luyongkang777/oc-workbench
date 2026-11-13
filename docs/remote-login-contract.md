# 一键登录补充契约（追加到 remote-accounts-contract.md 之后）

> 目标：不再让用户去设置页手工生成令牌。Gitea 直接用**账号密码**换令牌；GitHub 一键打开预填好权限的令牌页。

## 7.0 为什么两边的做法不一样

Gitea 的 `POST /api/v1/users/{username}/tokens` **接受 Basic Auth**。已实测：用错密码请求返回的是 `{"message":"invalid username, password or token"}`，而不是 `Token is required` —— 说明认证层收下了 Basic 头，只是密码不对。所以「用户名 + 密码 → 令牌」这一步在 Gitea 上是真实可行的。

GitHub 2021 年就禁用了密码认证，`POST /authorizations` 走不通；官方唯一免密钥的路径是 Device Flow，但要求先注册 OAuth App 拿 client_id。所以 GitHub 这边做成「一键打开已经预填 repo 权限的令牌创建页」，用户点一下生成、复制回来。

## 7.1 POST `/local/remote/login`

账号密码换令牌（Gitea）。

body：

```json
{ "baseUrl": "http://192.168.31.8:3000", "username": "luyongkang777", "password": "xxx", "kind": "gitea", "tokenName": "" }
```

规则：

- 只支持 gitea。`kind` 为空时先按 §2 的规则探测；探测出 github，或调用方直接传 github → 400「GitHub 不支持账号密码登录，请用令牌」。
- `baseUrl` 归一化、`apiBase` 推导沿用现有的 `normalizeBaseUrl` / `deriveApiBase`。
- `username` 必填，空 → 400「请填 Gitea 用户名」。
- `password` 必填，空 → 400「请填密码」。
- `tokenName` 为空时用 `oc-workbench-YYYYMMDD`（本地日期）。
- 请求：`POST <apiBase>/users/<urlencode(username)>/tokens`
  - 头：`Authorization: Basic base64(username:password)`、`Content-Type: application/json`、`Accept: application/json`
  - body：`{"name": "<tokenName>"}`
  - **不要传 `scopes`**：老版本 Gitea 不认识这个字段，不传等于全权限，兼容性最好。
- 成功响应里取 `sha1` 作为令牌（Gitea 返回形如 `{"id":3,"name":"...","sha1":"<令牌>","token_last_eight":"abcd1234"}`）。
- 拿到令牌后，再用它 `GET <apiBase>/user`，确认令牌真的能用，并取 `login` / `full_name`。
- 返回：

```json
{
  "kind": "gitea",
  "baseUrl": "http://192.168.31.8:3000",
  "apiBase": "http://192.168.31.8:3000/api/v1",
  "webUrl": "http://192.168.31.8:3000",
  "username": "luyongkang777",
  "name": "显示名",
  "token": "abcdef...",
  "tokenName": "oc-workbench-2026-11-13"
}
```

**安全硬要求（违反即视为缺陷）**：

- 密码只在本次请求内存里活到函数返回，**绝不写文件、写日志、回传前端**。
- 报错信息里不能带密码或完整的 Basic 头。
- 令牌按现有 `POST /accounts` 的规则保存。

错误映射：
- 401 → `用户名或密码不对`＋上游 message
- 403 → `这个账号没有创建访问令牌的权限`＋上游 message
- 404 于 `/users/{name}/tokens` → `这个 Gitea 版本不支持用接口创建令牌，请改用令牌方式`
- 传输层 → 沿用 §5 的翻译
- 超时 25s。

## 7.2 POST `/local/remote/open-url`

让外壳用系统默认浏览器打开一个地址（GitHub 令牌页靠它）。

body：`{ "url": "https://github.com/settings/tokens/new?scopes=repo&description=OpenCode%20工作台" }`

规则：

- 只接受 `http://` / `https://`，其它协议（`javascript:` / `file:` / `data:`）一律 400。
- 长度上限 2048。
- 实现：Rust 用 `open::that(url)`（`open` crate 已在依赖里，`main.rs` 195-206 行已有同样用法）；dev 侧 Windows 用 `cmd /c start "" "<url>"`，macOS `open`，Linux `xdg-open`。
- 失败不要影响调用方：记录日志后返回 `{ "ok": true }` 也行，但更好的做法是 500 + 「打开浏览器失败」。
- 返回 `{ "ok": true }`。

## 7.3 前端

「添加账号」卡片里，在服务器地址下面加一个**方式切换**（两个小按钮）：

- **一键登录**（默认，仅 Gitea）：服务器 + 用户名 + 密码 + 「登录并获取令牌」
- **粘贴令牌**：现有的服务器 + token 输入

切换规则：
- 类型选了 GitHub（或自动识别出 GitHub）时，禁用「一键登录」，并显示一句「GitHub 不支持账号密码登录」。
- GitHub 模式下给一个按钮「打开令牌创建页」，点击调 `openUrl`，地址：
  `https://github.com/settings/tokens/new?scopes=repo&description=OpenCode%20%E5%B7%A5%E4%BD%9C%E5%8F%B0`
  （scope 至少要 `repo`；同时给 `workflow` 也行，前端不硬编码多值，保持 `repo` 单值最稳）

表单细节：
- 密码框 `type="password"`，配「显示」切换，和 token 框一致。
- 密码框下面一行小字：`密码只用来换一次令牌，不会保存`。
- 「登录并获取令牌」按钮：加载中显示「登录中…」，成功后就地用返回的 token 走 `saveAccount`（不需要用户再点一次保存），然后刷新账号列表并选中新账号。
- 失败：卡片内红条显示后端 error 原文。

## 7.4 测试

- dev 侧 `scripts/remoteAccounts.test.mjs` 追加：
  - 假 Gitea 增加 `POST /api/v1/users/{name}/tokens`（校验 Basic 头里的用户名密码，对了返回 `sha1`）
  - 正确密码 → 拿到令牌、账号被保存、返回体里没有 password 字段
  - 错密码 → 401 且 error 文案是「用户名或密码不对」
  - kind=github → 400
  - `open-url` 的协议白名单：`javascript:` / `file:` 被拒，`https://` 通过
- Rust 侧加纯函数单测：Basic 头的 base64 构造、tokenName 的日期生成、open-url 协议校验。
