# 任务拆分（WorkBuddy 原生登录）

> 粒度：每条 ≤5 文件 / ≤300 行，做完并验证通过才开下一条。

## T1 令牌与登录接口（Rust）

文件：`shell/src/workbuddy.rs`、`shell/src/main.rs`、`shell/src/server.rs`
- 读取/写入 `%LOCALAPPDATA%\oc-workbench\workbuddy.json`
- 本机转发密钥：`settings.json` 的 `workbuddyKey`（没有就生成）
- 接口：`GET /local/workbuddy/status`、`POST /local/workbuddy/login/start`、`GET /local/workbuddy/login/poll`、`POST /local/workbuddy/logout`
- 刷新：`POST /v2/plugin/auth/token/refresh`

完成信号：单测通过；`status` 在未登录时返回 `configured=false`。

## T2 本地 OpenAI 兼容转发（Rust）

文件：`shell/src/workbuddy_proxy.rs`、`shell/src/server.rs`
- `GET /local/workbuddy/v1/models`（内置 CN 模型表）
- `POST /local/workbuddy/v1/chat/completions`（注入 WorkBuddy 头，SSE 流式转发）
- 鉴权：`Authorization: Bearer <workbuddyKey>`，该路径不要求 `x-oc-token`
- 401 时自动刷新令牌并重试一次

完成信号：单测通过；用真令牌能拿到流式回答。

## T3 前端区块与一键接入

文件：`src/api/workbuddy.ts`、`src/components/WorkBuddyBlock.tsx`、`src/components/ProviderPanel.tsx`
- 登录按钮 → 打开返回的 `url` → 每秒轮询 `login/poll`
- 已登录展示账号与到期时间，可退出
- 「接入 WorkBuddy」把地址 + 密钥填进表单并勾选全部模型

完成信号：dev 里能完成登录并写出一条 provider。

## T4 清理 Magpie 的 WorkBuddy 入口

文件：`shell/src/magpie.rs`（删）、`scripts/dev-local-magpie.*`（删）、`src/api/magpie.ts`（删）、`src/components/MagpieBlock.tsx`（删）、`vite.config.ts`、`src/styles/provider.css`
- 只保留 Magpie 作为普通预设，不再由它承担 WorkBuddy 登录

完成信号：`tsc` 干净，无未引用文件。

## T5 验收与出包

- `npm test`、`cargo test`、`npm run build:exe`
