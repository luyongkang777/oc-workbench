# progress — OpenCode 工作台

## 当前任务

**T8 收尾** — 状态：未开始（下一步）

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

- 2026-11-09 **T6 完成**：底部命令终端。
  - `src/api/terminal.ts`：创建一次性 PTY（`POST /api/experimental/session/<sid>/terminal`）+ 轮询 snapshot
  - `src/components/Terminal.tsx`：输入命令、流式输出、退出码、可折叠
  - 实测：`echo hello-terminal` / `git status --short` / 中文 `echo 中文测试` 都正常
  - 关键结论：PTY 的 WebSocket 需要 `x-opencode-ticket`（配对链接返回的 token），我们的客户端只有 cookie，
    所以用 REST snapshot 做「命令终端」（一条条执行），不是交互式 shell

- 2026-11-09 **T7 完成**：工作区改动审查。
  - `src/api/vcs.ts`：`/api/vcs/status` + `/api/vcs/diff?mode=working`（working 已包含未跟踪文件）
  - `src/components/ReviewPanel.tsx`：左侧变更列表（A/M/D + 增删数），右侧 patch 着色（+ 绿 / - 红 / @@ 蓝）
  - 顶栏「审查」按钮在代码视图和审查视图之间切换
  - 实测：临时新建 + 修改文件后，列表和 patch 都正确显示

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
