# progress — OpenCode 工作台

## 当前任务

**T5 会话面板** — 状态：未开始（下一步）

## 记录

- 2026-11-08 建立 product.md / tasks.md，开始 T1。
- 2026-11-08 T1 完成：`docs/api-notes.md` 记录 6 个端点真实响应。
  关键结论：认证是 `Set-Cookie: opencode_session_<端口>`（配对链接带 `Accept: text/html` 才给 302）；
  `fs/write` 是 binary body；SSE 无 `event:` 行，类型在 JSON `type` 里。
- 2026-11-08 T2 完成：Vite + React 18 + TS 骨架，端口 5273；
  `vite.config.ts` 自动 `opencode pair` → 取 Set-Cookie → 代理注入 cookie（实测 `/api/info` 200）。
- 2026-11-08 T3 完成：`FileTree.tsx` 懒加载 `/api/fs/list`，目录折叠、文件点击、选中高亮；
  过滤 node_modules/.git/dist/target 等噪音目录。
- 2026-11-08 T4 部分完成：`CodeView.tsx` 用 `/api/fs/read` 显示带行号源码（**只读，未接 Monaco、未做保存**）。
- 2026-11-08 Rust 外壳（`shell/`）编译通过，修复 `EventLoop::new()` 不带 Result、`run()` 缺返回值两处错误。
- 2026-11-08 **T8 完成（自包含）**：
  - `npm run build` 出 `dist`（148 KB JS）
  - Rust 用 `include_dir!` 内嵌 dist + `tiny_http` 起本地服务 + `/api` 反向代理注入 cookie
  - `auth.rs` 自动 `cmd /C opencode service status` / `opencode pair` 取 cookie
  - 实测：停掉 Vite 后 exe 仍正常显示三栏、顶部「已连接」、点文件能看源码
  - 产物 `shell/target/debug/oc-workbench-shell.exe`（2.83 MB）
- 2026-11-08 踩到的坑（写进技能 opencode-vite-web-client）：
  1. `Command::new("opencode")` 在 Windows 找不到 npm 的 .cmd shim，必须 `cmd /C opencode`
  2. 解析服务地址时用 `/` 当终止符会把 `http://` 截断，导致解析失败回退 dev
  3. Vite watcher 必须忽略 `shell/**`，否则 target 里 exe 被占用就 EBUSY 崩掉

## 阻塞

（无）
