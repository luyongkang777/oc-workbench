# 进度（WorkBuddy 原生登录）

## 当前任务

全部完成，待用户真机登录验收（需要在浏览器里真的扫码/输手机号，这一步只能人工）

## 记录

- 2026-11-17 立项。依据：用户要求「自己实现登录，不在 Magpie 里登」。
- 2026-11-17 实测上游登录接口：`POST https://copilot.tencent.com/v2/plugin/auth/state?platform=workbuddy`
  返回 `{code:0,data:{state,authUrl}}`；`GET /v2/plugin/auth/token?state=…` 未完成时返回 HTTP 200 + `code:11217`。
- 2026-11-17 T1 完成：`shell/src/workbuddy.rs`（状态/开始登录/轮询/退出/续期/本机密钥/端口校正）。
- 2026-11-17 T2 完成：`shell/src/workbuddy_proxy.rs`（模型表 + chat completions 转发，复用 `proxy::relay` 的 SSE 直写）。
  `/local/workbuddy/v1/*` 走独立密钥，在 `/local` 的 `x-oc-token` 校验之前分流。
- 2026-11-17 T3 完成：`src/api/workbuddy.ts`、`src/components/WorkBuddyBlock.tsx`；
  「接入 WorkBuddy」按当前 origin + 路径前缀现拼 baseURL（exe 端口随机、远程入口带 `/u/<id>/`）。
- 2026-11-17 T4 完成：删除 Magpie 的 WorkBuddy 入口（magpie.rs / MagpieBlock / dev-local-magpie / api/magpie）。
  Magpie 只保留为普通预设。
- 2026-11-17 T5：
  - `npm test` 591 通过 / 0 失败；`tsc --noEmit` 干净
  - `cargo test --bin oc-workbench-shell workbuddy` 8 通过
  - dev 实测：status(configured=false) → login/start 拿到真实 state+url → poll pending → models 15 条（flash 1M/128k）
  - `npm run build:exe` 出包 6.71 MB，exe 字节里能搜到 `/local/workbuddy/status`、`/local/workbuddy/v1/chat/completions`、`workbuddyKey`、`copilot.tencent.com`
- 2026-11-17 补：单机模式端口每次随机，provider 里写死的端口第二天会失效。
  增加 `workbuddy::heal_provider_port(port)`，启动时只校正 id=workbuddy 且指向 `…/local/workbuddy/v1` 的那一条。
- 待用户验收：在 exe 里点「登录 WorkBuddy」→ 浏览器扫码 → 接入 → 保存 → 模型下拉出字。
