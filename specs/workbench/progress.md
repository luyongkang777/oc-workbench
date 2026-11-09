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

- 2026-11-09 **打开任意文件夹**：
  - 外壳：main.rs 加 `oc:pick-folder` IPC 分支，主循环里用 rfd 弹原生「选择文件夹」对话框，选中回 `folder:<path>`、取消回 `folder:`
  - 前端：auth.ts 加 `onIpcMessage` 订阅非 token 消息；App.tsx 的 root 改为 state（localStorage key `oc-workbench:root`），资源管理器标题加「打开」按钮（有 IPC 走对话框，dev 走 prompt）
  - 实测：dev 模式 root 切到 F:\opencode\swarm-plugin 后文件树正确切换、刷新后保持；exe 内对话框弹出已截图验证
  - 依赖：Cargo.toml 加 rfd 0.15

- 2026-11-09 **第 2 轮审核修复（1 MAJOR + 7 MINOR）**：
  - MAJOR：切换目录后 Chat 仍绑旧目录会话 → `<Chat key={root}>` 重挂载 + `listSessions` 按 `location.directory` 过滤（后端字段是 `location.directory`，不是 `directory`）
  - ReviewPanel：root 变化先清空旧目录数据；断开时复位 loading（旧请求 finally 会被代际跳过）
  - applyRoot：递增 openSeq + abort 在途读文件，防止旧目录内容污染新视图
  - root 持久化改到 `%LOCALAPPDATA%\oc-workbench\root.txt`（exe 可能在只读目录），exe 同目录仅作回退；保存失败记日志
  - saved_root 校验目录存在（is_dir），失效路径不下发
  - IPC 分发逐个 try/catch，localStorage 写入容错
  - 自查发现：StrictMode 双跑 effect + booted 守卫会让 Chat 列表永久为空，已去掉 booted 改 alive 代际
  - 实测：切目录后 Chat 显示目标目录会话（workbench →「Workbench shell...」/ swarm-plugin →「工作台会话」）；root.txt 写入 LOCALAPPDATA 并在重启后读回

- 2026-11-09 **第 3 轮审核修复（1 MAJOR + 5 MINOR）**：
  - MAJOR：`listSessions` 原先只取全局最新 20 条再客户端过滤，排在 20 名之后的目录（如 F:\网卡 第 157 名）会误判为「无会话」并反复新建垃圾会话 → 改为按 `cursor.next` 最多翻 12 页收集
  - 去掉「空列表自动建会话」：改由发消息 /「+ 新会话」时创建，消除 StrictMode 双跑和连接抖动下的重复建会话
  - 列表刷新时保留用户当前会话（`prev` 仍在列表中就不切换）
  - root 初始化 `localStorage.getItem` 加 try/catch（禁用存储时不再白屏）
  - `applyRoot` 同路径只补持久化，不清编辑器状态（选同一目录不再关掉当前文件）
  - Terminal 加 `key={root}`，切目录后重建会话和输出
  - 实测：F:\网卡 翻页后列出 2 个历史会话；同目录重选后 AGENTS.md 仍打开

- 2026-11-09 **T10 回复 Markdown 渲染**：
  - `MarkdownText.tsx`：react-markdown 10 + remark-gfm，默认不渲染原始 HTML（自带 XSS 防护）；链接点击经 `oc:open-url:` IPC 交外壳，用系统默认浏览器打开
  - `markdown.css`：标题/列表/行内代码/代码块/表格/引用/分隔线，尺寸按聊天面板压小；覆盖 `.chat-bubble` 的 pre-wrap
  - 用户气泡保持纯文本，只渲染 assistant 回复
  - 实测：网卡会话 12 个 md 块、74 个代码块、27 个表格、99 个列表项全部渲染；构建后 JS 337 KB（gzip 106 KB）

- 2026-11-09 **T10 轮审核修复（1 MAJOR + 4 MINOR）**：
  - MAJOR：`target=_blank` 在 wry 里被直接取消（没有 new_window_req_handler），链接全是死链 → 改为点击经 `oc:open-url:` IPC 交给外壳，用 open crate 调系统默认浏览器打开（协议白名单 http/https/mailto）
  - 空 `href`（`[x]()` / `javascript:` 被清洗）不再渲染成死链接，只显示文字
  - `MarkdownText` 加 `memo`，remark 插件与 components 提到模块级常量（流式期间旧消息跳过同步解析）
  - 加 `remark-breaks`：单换行渲染成 `<br>`，不再被 `white-space: normal` 折叠
  - 图片不再自动加载（防远程图片静默外联），渲染成 `[图片：alt]` 占位
  - 实测：测试会话 DOM 1 个安全链接 / 0 个空链接 / 2 个 br / 图片占位；exe 里点链接系统 Edge 打开 example.com

- 2026-11-09 **T10 第二轮审核修复（1 MAJOR + 4 MINOR）**：
  - MAJOR：`open::that` 会在 Windows 上同步跑 PowerShell 并等它退出（约 1 秒），而调用点在 WebView2 UI 线程 → 点链接卡窗口、极端情况永久无响应。改为 `std::thread::spawn` 子线程，IPC 回调只转发
  - 链接失败经 `failures` 队列（Arc<Mutex<Vec<String>>>）回主循环下发 `open-url-failed:`，页面顶部提示 4 秒
  - 协议白名单大小写统一：外壳先 `to_ascii_lowercase` 再比，前端正则收紧成 `^(?:https?:\/\/|mailto:)`（`HTTPS://` 也能打开）
  - 链接补 `onAuxClick` 拦截：中键不再触发默认导航（之前中键 = 死链）
  - 修正 progress.md 里 target=_blank 与后续修复说明的矛盾

- 2026-11-09 **T10 第三轮审核修复（1 MAJOR + 2 MINOR）**：
  - MAJOR：`onAuxClick` 没判断 `event.button`，右键点链接也会拉起浏览器 → 只拦中键（`button === 1`）
  - 提示条改带 id 的对象，连续两次相同失败也能重开 4 秒计时（原字符串相等导致第二次被旧定时器清掉）
  - 失败回执的 `evaluate_script` 加错误日志（页面重载时不再静默丢失）
  - 实测：真实鼠标事件右键不开浏览器、中键/左键正常打开

### T10 审核结论：PASS（第 4 轮，2026-11-09 16:47）

- 报告：`C:\backup\review-feature_workbench-v0-20261109-164700.md`
- 累计修复：第 1 轮 1 MAJOR + 4 MINOR（死链/空 href/memo/换行/图片外联）→ 第 2 轮 1 MAJOR + 4 MINOR（同步阻塞/大小写/中键/失败提示/文档矛盾）→ 第 3 轮 1 MAJOR + 2 MINOR（右键误开/提示计时/回执日志）→ PASS
- 未阻塞项：页面重载瞬间到达的失败回执可能丢（已记日志），不影响合并

- 2026-11-09 **自动拉起 opencode 服务**：
  - 需求：双击 exe 即可用，不再需要先开命令行跑 opencode。
  - `auth.rs`：`service status` 拿不到地址时自动 `service start`（45 秒窗口，500ms 轮询 status）；
    `wait_with_timeout` 增加超时参数（冷启动比普通子命令慢），`run_start` 用 `strict=false`：跳过管道完整性校验、超时只结束直接子进程。
  - 若 `service start` 报错或超时，返回带原因的日志，外层仍每 5 秒重试。
  - 实测：①有服务时 exe 启动不重启服务（PID 不变）；②假 shim 模拟「status 无地址」→ 调用序列 status→start→pair。

- 2026-11-09 **T11 审核修复（1 MAJOR + 4 MINOR）**：
  - MAJOR：两个 45 秒窗口叠加（start 45s + 轮询再 45s，管道 5s）→ 改成先取 deadline，start 和轮询共用；实测 start 卡 60 秒时总等待 45.1 秒
  - status 的 Err 不再一律吞掉：命令本身起不来（没装/不在 PATH）直接返回诊断，只有「未运行」才继续 start
  - `run_start`：超时不 taskkill 整树（避免杀掉刚拉起的服务），管道收不齐也不算失败（服务可能持有 stdout/stderr）
  - 前端 reconnect 超时从 15 秒放宽到 90 秒（覆盖服务自动拉起窗口）

- 2026-11-09 **T11 第二轮审核修复（1 MAJOR + 4 MINOR）**：
  - MAJOR：「opencode 没装」判定永远不命中（`cmd` 本身能 spawn 成功，真正失败是退出码 9009 + stderr「不是内部或外部命令」）→ `command_missing()` 按退出码/本地化文案识别，实测 58ms 直接返回、不执行 start
  - `run_start` 改为 `Stdio::null()` 独立实现：不再起读管道线程（服务 detach 后管道永不关闭会泄漏线程/句柄），超时只结束直接子进程
  - 自动启动后先 `probe_ready`（3 次、2s 超时）再 pair，避免服务刚监听时首轮必然失败
  - 前端 reconnect 超时放宽到 180 秒（含排队等 discover 锁的时间）
  - 修正 progress 里 `run_with_timeout` 的错误函数名

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
