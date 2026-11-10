# progress — OpenCode 工作台

## 当前任务

**T13 已交付（大文件阅读 + 虚拟滚动）；下一步待评估项见 tasks.md**

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
    `wait_with_timeout` 增加超时参数（冷启动比普通子命令慢）；`run_start` 独立实现：`Stdio::null`、不起读管道线程、stderr 落临时文件、超时只结束直接子进程。
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

- 2026-11-09 **T11 第三轮审核修复（2 MAJOR + 7 MINOR）**：
  - MAJOR：`command_missing` 靠 stderr 文案判断，中文 Windows 上是 GBK 字节（lossy 后匹配不到）→ 改用 `where opencode` 探测（与语言无关），找不到直接报错不空等
  - MAJOR：`run_start` 丢 stderr 且失败后仍等满窗口 → stderr 落临时文件（不起读线程），非 0 退出立即返回原因；discover 收到 Err 先查一次 status（端口占用但服务已在跑的情况）
  - 启动窗口 45s → 120s，对齐 opencode CLI 的 promiseTimeout
  - start 成功后先查一次 status 再进轮询（刚成功不被判超时）
  - probe 探活次数 3 → 2，前端重连超时 180s → 300s，README 改为「约 2 分钟」
  - 修正 progress 里 `strict=false` 的过时描述

- 2026-11-09 **T11 第四轮审核修复（2 MAJOR + 3 MINOR）**：
  - MAJOR：`service status` 的 Err 被 `unwrap_or_default()` 吞成「未运行」→ 正常未运行实测是 `stopped` + exit 0，Err 属异常，直接带命令与 stderr 报错（不再空等 150 秒）
  - MAJOR：`where opencode` 探测无超时（PATH 里有网络共享会挂几分钟）→ 3 秒超时，区分「没找到」与「探测超时」
  - `run_start` 超时分支先读已产生的 stderr 再拼错误；stderr 读取改 `read` + `from_utf8_lossy`（GBK 不丢）
  - 启动窗口 120s → 150s（比 CLI 自己的 120s 多 30s 余量）
  - 文档口径统一：client.ts 注释、tasks.md T11 范围（补 client.ts）、README 改「约 2 分半」
  - 实测：真实环境正常；status 失败立即报错且不执行 start；PATH 无 opencode 立即报「未安装」

- 2026-11-09 **T12 模型选择 + 停止对话**：
  - `chat.ts`：`listModels` / `getDefaultModel` / `switchModel` / `interruptSession` / `getSession` / `isSessionBusy`；`createSession` 支持传 model
  - `ChatHeader.tsx`：会话下拉 + 模型下拉（筛选、68 个模型、当前项高亮）+ 新会话；从 Chat.tsx 拆出
  - `ChatInput.tsx`：生成中「发送」变「停止」，从 Chat.tsx 拆出
  - `hooks/useChatEvents.ts`：SSE 订阅 + 250ms 合并刷新，从 Chat.tsx 拆出
  - 生成中判定：`time.busy > time.idle`，running 期间 800ms 轮询会话状态（不用 idle 消息判断，避免旧 idle 误判）
  - 实测：切模型后会话 model = iceman-free；ping 任务生成中出现「停止」，点击后 outcome=interrupted

- 2026-11-09 **T12 审核修复（2 MAJOR + 7 MINOR）+ 用户反馈排版**：
  - 用户反馈：顶部三个按钮挤在一起、模型名被截断、「破甲」模型全部同名（`shortModel` 把「破甲 · DeepSeek 官方」截成「破甲」）→ 去掉字符串截断，交给 CSS 省略 + title；header 加 gap，宽度按 会话 38% / 模型 flex 1 / 新会话 auto 分配
  - 模型下拉继承 `.chat-header` 的 uppercase + 0.6px 字距（模型名变形）→ `.model-menu` 统一重置
  - MAJOR：模型显示不跟随会话（无 model 的会话沿用上一个选的）→ `useChatModels` 记 `defaultModel`，切换时按 会话 model > 默认模型 > 空
  - MAJOR：`running` 是全局布尔，切走再切回丢「停止」→ `useChatRunning` 用 `runningID` 绑定会话，切会话按 busy 初始化，轮询只查该会话，连续失败 5 次放弃
  - 切模型先请求成功再改 UI（失败不再显示错误模型）；同 id+provider 保留原 variant（实测 high 不再被改成 default）
  - 生成中按 Enter 不再发送（保留草稿）
  - `interrupt` 返回 false 时不清 running，再查一次 busy
  - 模型列表加 loading / 加载失败点击重试 / 空列表三种状态
  - Chat.tsx 拆到 215 行（模型/运行状态各一个 hook）
  - 实测：切会话再切回「停止」仍在；variant 保留 high；生成中 Enter 不发；破甲模型显示全名

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

- 2026-11-09 **会话下拉只列工作台会话**（用户反馈：同目录里 CLI/审核脚本的会话全列出来，不需要）：
  - `chat.ts`：建会话时带 `metadata: { source: 'oc-workbench' }`；新增 `isWorkbenchSession`（排除终端会话）、`isWorkbenchTerminal`
  - `terminal.ts`：终端会话带 `metadata: { source, kind: 'terminal' }`，既不算用户会话，也不占「外部会话」计数
  - `Chat.tsx`：下拉默认只列工作台会话（当前会话即使是外部会话也保留）；默认选中优先工作台会话，回退时跳过终端会话
  - `ChatHeader.tsx`：下拉底部「显示全部会话（另有 N 条外部会话）」/「只显示工作台会话」切换，N 为 0 时不出按钮
  - 实测：workbench 目录 28 条 → 默认 2 条；「显示全部」多出 26 条；终端会话不出现在列表也不计入 N
  - 数据迁移：按标题「工作台会话」「工作台终端」给历史会话补 metadata（`PATCH /api/session/<id>`，服务端支持并保留，实测切模型/发消息不会冲掉）

- 2026-11-09 **消息气泡加复制按钮**（用户反馈）：
  - `MessageList.tsx`：新增 `copyText`（Clipboard API，失败退回 `execCommand`）和 `CopyButton`（成功显示「已复制」1.2 秒、失败显示「复制失败」，定时器卸载时清理）
  - 用户提问复制原文；助手回复复制 Markdown 原文（`texts.join('\\n\\n')`，和渲染内容一致）
  - `panels.css`：气泡外套 `.chat-bubble-wrap`（定位按钮），`.chat-copy` 常显 0.42 透明度、hover/focus 变亮
  - 实测：点用户气泡复制到剪贴板 38412 字符（完整 review 提示词）；点助手气泡 2956 字符（Markdown 原文），按钮显示「已复制」

- 2026-11-09 **复制按钮审核修复**（集群审核 1 MAJOR + 9 MINOR）：
  - MAJOR：`.chat-copy` 常显 0.42 透明度且 absolute 压在气泡首行上，用户消息首行结尾约 2 个汉字被半透明块常驻覆盖（对比度约 2.8:1）。改为 `opacity:0` + `pointer-events:none`，只在 `:hover` / `:focus-visible` 时恢复可见可点，默认态不遮挡也不吃拖选
  - 极短消息（单字）按钮比气泡宽、溢出到气泡外：`.chat-bubble-wrap` 加 `min-width:36px`（按钮 34px + right 2px）
  - `done` 状态不随 `text` 变化复位：流式输出时「已复制」会贴到新增长的内容上 → 加 `useEffect(() => setState('idle'), [text])`
  - timer 在 `await` 之后才建立，卸载窗口内会留下悬挂 timer → 加 `alive` ref，await 回来先判、timer 回调再判
  - textarea 兜底清理移到 `finally`（异常时不再把隐藏节点留在 body 上），并 `readOnly` + 复制结束归还焦点
  - 按钮补 `aria-label`（随状态切换，读屏能播「已复制 / 复制失败」）；`.chat-copy` 加 `font-family:inherit`、`white-space:nowrap`；`.done` 成功色对齐项目既有 `#4ec9b0`
  - 验证：`tsc --noEmit` 通过、`vite build` 通过；无头 Edge 实测 380px 面板下默认态 `opacity:0 / pointer-events:none`，助手首行零重叠，单字气泡溢出 0px

- 2026-11-09 **复制按钮移到右下角 + 右键菜单**（用户反馈：别在最顶上）：
  - `.chat-copy` 从 `top:2px` 改为 `bottom:2px`，按钮落到底部右下角，不再压首行；残留遮挡只剩最后一行末尾，且 hover 才出现
  - 气泡支持右键：`onContextMenu` 弹 `.chat-menu`（fixed 定位 + 视口边界收拢），菜单项「复制这条消息」，复制后短暂显示「已复制」再关闭；点空白 / 滚动 / Esc 关闭
  - 选中一段文字时右键不拦截，保留浏览器原生菜单（「复制选区」仍可用）
  - `.chat-bubble-wrap` 的 `min-width` 36 → 46px，覆盖「已复制」最宽状态（44px + right 2px）；失败文案从「复制失败」缩成「失败」避免按钮变宽出框（`aria-label` 仍是完整的「复制失败」）
  - 实测：无头 Edge 380px 面板下三处按钮均 `bottom/right` 间距 2px、完全落在气泡内；`tsc` + `vite build` 通过

- 2026-11-09 **任意大小文件阅读 + 连点不卡**（用户反馈：>500KB 看不了、点频繁卡死）：
  - 根因：`client.ts` 写死 500KB 预览上限；CodeView 把整份文本拆成逐行 DOM（15 万行 = 15 万节点）；文件树每次点选重排全部已展开节点；读文件走 opencode 上游 `/api/fs/read`（整份返回），快速连点会同时压住外壳 64 个并发名额和上游
  - Rust：新增 `/local/fs/*`（list/stat/read/text/raw/hex）。`fsindex` 一次扫描建「行号 → 字节偏移」稀疏检查点（每 4096 行），`fsread` 按行窗口读取（UTF-8/UTF-16 BOM、CRLF 归一、单行 >256KB 截断、单窗口 ≤512KB），索引按 path+size+mtime 缓存 8 份；`resolve` 逐段拒绝 `..`/盘符，canonicalize 后做前缀校验；与 `/api` 同一道 `x-oc-token`
  - 前端：CodeView 虚拟滚动（19px 行高、200 行一页、overscan 60、最多缓存 24 页、滚动 rAF 合并）；FileTree 拍平 + 行虚拟化（24px 行高、只渲染视口 ±10 行）；App 不再持有文件内容，读取只发生在 CodeView，避免整个 App 连同会话面板重渲染；新增 `api/localfs.ts`、`components/codeWindow.ts`
  - 预览：Markdown ≤1MB 用 react-markdown，超过自动提示并留在源码；图片走 blob URL；二进制显示前 4KB hex
  - dev：`scripts/dev-local-fs.mjs` 与 Rust 同语义，供浏览器实测；`vite.config.ts` 注册插件
  - 实测（headless Edge 157 + CDP）：7.2MB/150,000 行 → 首屏 99 行、scrollHeight 2,850,032、滚到底 149,905–150,000 行正确；32.5MB/600,000 行 → 滚到底 599,905–600,000；1.1MB md → 预览提示 1MB 上限、源码 47,999 行分页；EXE 头 hex 以 `4d 5a 90 00` 开头；PNG blob 预览 naturalWidth 640；5 个文件连点 40 次 1044ms、最长帧间隔 21ms；展开 6 个目录后文件树只渲染 40 行、整页 DOM 230 节点
  - 坑：① vite 默认 watch 会监听浏览器 profile（`.tmp/edge-profile`）导致 EBUSY 把 dev server 直接搞崩 → `.tmp` 进 `watch.ignored`，profile 移到 `%TEMP%`；② React StrictMode 下 FileTree 会挂载-卸载-重挂，实测脚本必须等行数连续 3 次一致再点；③ 旧 exe 正在运行（20:43 起）导致 `cargo build` 报 os error 5，改用独立 `CARGO_TARGET_DIR` 构建后优雅关闭窗口替换；④ Rust 源码里的双反斜杠字符字面量经工具链被吃成单反斜杠，改用 `char::from(92u8)`；⑤ 文件首次打开要整份扫描建索引（30MB ≈ 数百 ms），之后命中缓存；⑥ Markdown 预览仍整份渲染，所以设 1MB 上限，源码模式不受限
  - 验证：cargo test 19 项（含 `/local` token 门禁、list/stat/read 往返、越界 400）、`tsc --noEmit`、`vite build`、dev 实测、生产 exe 启动日志

- 2026-11-09 **集群审核修复（3 路并行：Rust / 前端 / 跨层文档）**：
  - BLOCKER 修：分页不再假设「一页 200 行」——服务端 512KB 上限会让窗口少给行，前端改为按 `next` 续拉、按页覆盖区间找行，超长行（30×40KB）实测 30 行全部可读、`pendingRows=0`；FileTree 的 `load()` 从 setState 更新函数里移出（改由 effect 派发），StrictMode 下不再重复请求或永久「加载中」
  - MAJOR 修：切文件时用 `statPath` 防止「路径是新的、内容是旧的」一帧；页请求全部带 AbortController，切文件即 abort；预览→源码滚动位置恢复；滚动高度超过 1600 万 px 时按比例压缩（>176 万行仍能滚到末行）；stat 失败加「重试」按钮；点同一文件用 `openSeq` 强制重读；`readLines` 超时 60s、索引过期时服务端回 `eof` 防止原地重试
  - 工程拆分：Rust `fsapi`(294) / `fsutil`(89) / `fsdecode`(88) / `fsread`(244)；前端 `CodeView`(309) / `CodeSourceBody` / `CodeToolbar` / `codeCache` / `useFilePreview`；新增 7 项虚拟滚动纯函数测试（node --test）与 1 项「索引过期」回归测试（Rust 20 项）
  - dev 中间件对齐：字节数按 UTF-8 计算、单行 256KB 截断、先校验路径段再 realpath、raw 流错误处理、text 对二进制 415、`/local` 无斜杠也拦截、参数非法回落；已知差异（无 token、UTF-16 >64MB）写进 docs §9
  - 文档：T4 改成实际的只读查看（保存未做）、T13 完成信号改为「语义对齐」、product 单文件约束改为 ≤350、README 补 exe 被占用时的独立 target 目录做法
  - 复测：7.2MB/150,000 行与 32.5MB/600,000 行滚到底正确；1.1MB md 预览降级、源码 47,999 行；PNG naturalWidth 640；EXE 头 hex；5 文件连点 40 次 maxGap 20ms；文件树展开 6 目录仅 40 行 / 230 DOM 节点

- 2026-11-09 **跳转到行**：源码模式工具栏加行号输入 + 回车/按钮跳转；按「行号 × 行高 × 压缩比」算 scrollTop 并夹到可滚动范围，目标行落到视口顶部并高亮 1.2 秒；超大文件（滚动高度已压缩映射）同样适用

- 2026-11-09 **跳转增强**：Ctrl+G / Cmd+G 聚焦并全选行号输入框；工具栏实时显示「第 N 行」（scrollTop × 压缩比反算，夹到 1..lineCount）；`lineAtScrollTop` 纯函数加单测。实测 60 万行文件跳 300,000 行后显示「第 300,000 行」、目标行高亮、Ctrl+G 聚焦为 true

- 2026-11-09 **Ctrl+F 搜索 + 文件树刷新 + 键盘滚动**：
  - Rust 新增 `/local/fs/search`（`fssearch.rs`）：复用分页窗口逐段扫描，大小写不敏感、`limit` 截断、`from` 续扫；核心 `find_matches` 有单测（默认上限/大小写敏感）
  - 前端搜索条：Ctrl+F 打开并聚焦、250ms 防抖、abort 旧请求、`1/N+` 计数、上下跳回绕、命中片段 `<mark>` 高亮、当前命中行底色；Esc 关闭；切文件自动重搜
  - 文件树：标题栏「刷新」+ 窗口 focus 自动重拉所有已加载目录（保留展开状态）
  - 代码区可聚焦，Home/End 直达首尾
  - 实测：32.5MB/60 万行搜 `end-599999` → `1/1`、1 处 `<mark>`、1 行命中底色，视口落在末行附近；连点 40 次仍 maxGap 22ms
