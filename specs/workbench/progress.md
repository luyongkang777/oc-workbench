# progress — OpenCode 工作台

## 当前任务

**T5 会话面板** — 状态：未开始（下一步）

## 记录

- 2026-11-08 建立 product.md / tasks.md，开始 T1。
- 2026-11-08 T1 完成：`docs/api-notes.md` 记录 6 个端点真实响应。
  关键结论：认证是 `Set-Cookie: opencode_session_<端口>`（配对链接带 `Accept: text/html` 才给 302）；
  `fs/write` 是 binary body；SSE 无 `event:` 行，类型在 JSON `type` 里。
- 2026-11-08 T2 完成：Vite + React 18 + TS 骨架，端口 5273；dev 代理自动配对并注入 cookie。
- 2026-11-08 T3 完成：`FileTree.tsx` 懒加载 `/api/fs/list`，过滤 node_modules/dist/target。
- 2026-11-08 T4 部分完成：`CodeView.tsx` 只读源码（未接 Monaco、未做保存）。
- 2026-11-08 T8 完成：Rust 内嵌 dist + tiny_http 本地服务 + `/api` 反代，单文件 exe 双击可用。
- 2026-11-08 提交到 Gitea：`http://192.168.31.8:3000/luyongkang777/oc-workbench`
  （`main` + `feature/workbench-v0`），随后跑了 6 轮 AI 审核。

## 审核结果（ai-review-gate）

| 轮次 | 结论 | 主要问题 |
|---|---|---|
| 1 | FAIL | 本地代理无鉴权；切文件竞态 |
| 2 | FAIL | token 可从 GET / 白拿；后端离线白屏；子进程无超时 |
| 3 | FAIL | 启动失败永久 502；>32KB 丢 Content-Length；lock 与 package.json 不一致 |
| 4 | FAIL | 冷启动抢跑导致文件树永久「加载失败」 |
| 5 | FAIL | token 只下发一次导致重载后失效；SSE 被缓冲 8KB 不是实时 |
| 6 | **PASS** | 无 BLOCKER/MAJOR，剩余均为可后续优化的 MINOR |

最终报告：`C:\backup\review-feature_workbench-v0-20261108-230403.md`

## 剩余 MINOR（不阻塞，后续清理）

- `server.rs` 521 行，超过项目自定的 300 行；`proxy` 函数偏长
- `client.ts` 500KB 限制用 `text.length`（UTF-16 单元）而非字节
- `reconnect` 失败原因没有显示在界面上，只写日志
- `/api/reconnect` 在后台 discover 未完成时可能排队超时
- `auth.rs` 的 `find_base` 只取第一个地址（本地形态没问题，UNCERTAIN）
- `build.rs` 缺 `rerun-if-changed=../dist`

## 阻塞

（无）
