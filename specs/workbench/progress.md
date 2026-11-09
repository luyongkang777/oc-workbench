# progress — OpenCode 工作台

## 当前任务

**T6 终端** — 状态：未开始（下一步）

## 记录

- 2026-11-08 建立 product.md / tasks.md，开始 T1。
- 2026-11-08 T1 完成：`docs/api-notes.md` 记录 6 个端点真实响应。
  关键结论：认证是 `Set-Cookie: opencode_session_<端口>`（配对链接带 `Accept: text/html` 才给 302）；
  `fs/write` 是 binary body；SSE 无 `event:` 行，类型在 JSON `type` 里。
- 2026-11-08 T2 完成：Vite + React 18 + TS 骨架，dev 代理自动配对并注入 cookie。
- 2026-11-08 T3 完成：`FileTree.tsx` 懒加载 `/api/fs/list`，过滤 node_modules/dist/target。
- 2026-11-08 T4 部分完成：`CodeView.tsx` 只读源码（未接 Monaco、未做保存）。
- 2026-11-08 T8 完成：Rust 内嵌 dist + tiny_http 本地服务 + `/api` 反代，单文件 exe 双击可用。
- 2026-11-08 提交到 Gitea：`http://192.168.31.8:3000/luyongkang777/oc-workbench`
  （`main` + `feature/workbench-v0`），随后跑了 9 轮 AI 审核。

- 2026-11-09 **T5 完成**：会话面板可用。
  - `src/api/chat.ts`：会话列表/新建/历史/发消息，SSE 用 fetch 流解析（EventSource 不能带 `x-oc-token`）
  - `src/components/Chat.tsx`：会话切换、消息列表、工具卡片、Enter 发送
  - 实测（dev 模式 + 浏览器自动化）：新建会话 → 发「只回复 OK」→ 收到「好的」
  - 修掉一个 dev 代理问题：浏览器给同源 POST 带的 `Origin: 5273` 被 opencode 当跨站拒掉（401），代理转发现已去掉 Origin/Referer

## 审核结果（ai-review-gate）

| 轮次 | 结论 | 主要问题 |
|---|---|---|
| 1 | FAIL | 本地代理无鉴权；切文件竞态 |
| 2 | FAIL | token 可从 GET / 白拿；后端离线白屏；子进程无超时 |
| 3 | FAIL | 启动失败永久 502；>32KB 丢 Content-Length；lock 与 package.json 不一致 |
| 4 | FAIL | 冷启动抢跑导致文件树永久「加载失败」 |
| 5 | FAIL | token 只下发一次导致重载后失效；SSE 被缓冲 8KB 不是实时 |
| 6 | PASS | — |
| 7 | FAIL | 配对链接被拼进错误串（会进日志/界面） |
| 8 | FAIL | 冷启动探活撞上后台未就绪，最长 10 秒不可用 |
| 9 | **PASS** | 无 BLOCKER/MAJOR |

最终报告：`C:\backup\review-feature_workbench-v0-20261109-061726.md`

## 已完成的 MINOR 清理（2026-11-09）

- `server.rs` 521 行 → 拆成 `server.rs` / `proxy.rs` / `body.rs`
- 大文件限制按 UTF-8 实际字节判断
- 重连失败原因显示在侧栏
- `build.rs` 补 `rerun-if-changed=../dist`
- 错误串里的配对链接统一 `<redacted>`
- 删掉误写的 `$ARGS`
- 断开态 1 秒快轮询，冷启动 3 秒内可用
- 文档（progress / api-notes）与实现对齐

## 仍待处理（MINOR，不阻塞）

- `/api/reconnect` 在后台 discover 未完成时可能排队超时（后台会自愈）
- 401 后没有自动重连（只能点「重试」）
- `DEFAULT_ROOT` 写死 `F:\opencode\workbench`，没有「打开文件夹」
- 真实文件行数统计下 `server.rs`/`auth.rs`/`main.rs` 仍略超 300 行的自定规则
- 代理不支持 WebSocket 升级（T6 终端需要）
- dev 模式下「重试」按钮打 `/api/reconnect` 会 404（只影响开发，不影响 exe）

## 阻塞

（无）
