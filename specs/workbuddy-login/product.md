# WorkBuddy 原生登录接入

## 目标

在 oc-workbench 的「第三方 API 接入」面板里，**由工作台自己完成 WorkBuddy 登录**（腾讯浏览器登录页 + 令牌轮询），
登录后把 WorkBuddy 的模型接成一条可用的 provider，不再依赖 Magpie。

## 用户可见结果

1. 面板顶部出现「WorkBuddy」区块，显示未登录 / 已登录（账号名）/ 令牌到期时间。
2. 点「登录 WorkBuddy」→ 系统浏览器打开腾讯登录页 → 工作台每秒轮询 → 登录成功后区块自己变成已登录。
3. 已登录后点「接入 WorkBuddy」→ 自动填好地址与本机密钥、勾选全部 WorkBuddy 模型 → 点「保存」写进 `opencode.json`。
4. 退出登录按钮清掉本机令牌。

## 不做

- 不读 WorkBuddy 桌面版的登录文件（5.6 起加密，读不到，也没有绕过的必要）。
- 不实现 WorkBuddy 的 Claude `/v1/messages` 通道（先只做 chat completions）。
- 不接管 Magpie 的账号池；Magpie 只保留为普通预设，不再承担 WorkBuddy 登录。

## 验收标准

1. 未登录时 `GET /local/workbuddy/status` 返回 `configured=false`，区块显示「未登录」，按钮可点。
2. 点登录后 `POST /local/workbuddy/login/start` 返回 `state` + `url`，浏览器能打开登录页。
3. 登录完成前 `GET /local/workbuddy/login/poll` 返回 `pending=true`；完成后返回 `done=true` 且带账号名。
4. `GET /local/workbuddy/v1/models` 返回全部 WorkBuddy 模型（含 `deepseek-v4.1-flash`，上下文 1000000）。
5. `POST /local/workbuddy/v1/chat/completions` 能把 SSE 原样流式转发回 opencode。
6. 令牌过期时自动用 refresh 续期；续期失败明确提示「重新登录」。
7. 面板「接入 WorkBuddy」写出的 provider 能被 opencode 正常调用（模型下拉可见、能出字）。

## 约束

- 令牌只落本机文件 `%LOCALAPPDATA%\oc-workbench\workbuddy.json`，不出现在日志与前端响应里。
- 本地转发接口用独立随机密钥（存在 settings.json），不复用页面令牌。
- 上游固定 `https://copilot.tencent.com`，请求头按 WorkBuddy 5.9.3 桌面客户端伪造（UA 不对会被 10085 拒）。
