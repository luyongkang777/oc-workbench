# tasks — OpenCode 工作台

规则：一次只做一条，做完验证通过才开下一条。每条 ≤ 5 个文件、≤ 300 行。

## T1 ✅ 接口实测

- 范围：新建 `docs/api-notes.md`
- 内容：用真实请求验证 6 个端点，记录 URL、参数、返回结构、坑
  1. `GET /api/fs/list`
  2. `GET /api/fs/read/<path>`
  3. `POST /api/experimental/fs/write`
  4. `POST /api/session` + `POST /api/session/<id>/prompt`
  5. `GET /api/event`（SSE 事件名）
  6. `POST /api/pty`
- 验收：文档里每条都有真实响应样例；能据此写出前端调用代码
- 完成信号：`api-notes.md` 存在且 6 条齐全

## T2 ✅ 前端骨架

- 范围：`package.json` `vite.config.ts` `index.html` `src/main.tsx` `src/App.tsx`
- 内容：Vite + React + TS；dev 代理 `/api` 到 opencode 服务；三栏布局 + 底部终端占位
- 验收：`npm run dev` 打开后 3 秒内看到三栏；顶部有连接状态
- 完成信号：页面能跑，无控制台报错

## T3 ✅ 文件树

- 范围：`src/api/client.ts` `src/components/FileTree.tsx` `src/App.tsx`
- 内容：调 `/api/fs/list` 懒加载目录，点击文件回调
- 验收：展开 `F:\opencode\workbench` 能看到真实文件；点文件能拿到路径
- 完成信号：树可展开两级以上

## T4 ✅ 编辑器（查看 + 编辑保存）

- 范围：`src/components/CodeView.tsx` `src/components/CodeEditor.tsx` `src/api/client.ts` `shell/src/fsapi.rs`
- 内容：只读查看（行号 + 虚拟滚动 + 分页读取）；2026-11-10 补上编辑：`PUT /local/fs/write` 原子写回，
  ≤2MB，双击进入；编码支持 UTF-8 / UTF-16LE / UTF-16BE / GBK，保存时可用工具栏下拉换编码；
  Ctrl+S 保存、mtime 冲突 409，保留 BOM / CRLF；未接 Monaco
- 验收：点文件能看到带行号的源码；大文件按页加载、滚动不卡；改一行 Ctrl+S 后磁盘内容更新、切走前会提示未保存
- 完成信号：编辑闭环（保存单列已收敛）

## T5 ✅ 会话面板

- 范围：`src/components/Chat.tsx` `src/api/client.ts` `src/hooks/useEvents.ts`
- 内容：会话列表/新建、发消息、SSE 订阅流式内容
- 验收：发"列出当前目录的文件"能看到流式回复与工具卡片
- 完成信号：不刷新页面能收到增量

## T6 ✅ 终端

- 范围：`src/components/Terminal.tsx`
- 内容：xterm.js 接 `/api/pty`
- 验收：能执行 `echo hello` 并显示输出
- 完成信号：输入输出正常，窗口缩放正常

## T7 ✅ diff 审查

- 范围：`src/components/DiffView.tsx` `src/api/client.ts`
- 内容：`/api/vcs/status` + `/api/vcs/diff`，Monaco DiffEditor 展示
- 验收：agent 改文件后能列出变更并看到增删
- 完成信号：点变更文件能看到 diff

## T8 ✅ 桌面壳

- 范围：`src-tauri/*` 或 `electron/*`（按 T2 结论定）
- 内容：打包成单窗口桌面程序，启动时自动拉起/连接本地服务
- 验收：双击 exe 能打开界面并连上后端
- 完成信号：无需手动开终端

## T9 ✅ 打开任意文件夹

- 范围：`shell/src/main.rs`（IPC）、`src/api/auth.ts`、`src/App.tsx`、`src/styles/panels.css`
- 内容：资源管理器标题「打开」按钮 → rfd 原生对话框 → `folder:<path>` 回传 → 文件树/Chat/Terminal 整体切目录；root 存 `%LOCALAPPDATA%\oc-workbench\root.txt` 跨启动恢复
- 验收：对话框选目录后文件树切换；重启 exe 后自动回到上次目录；会话按 `location.directory` 隔离
- 完成信号：exe 内完整闭环实测通过（2026-11-09）

## T10 ✅ 回复 Markdown 渲染

- 范围：`src/components/MarkdownText.tsx`、`src/components/MessageList.tsx`、`src/styles/markdown.css`、`package.json`
- 内容：react-markdown + remark-gfm 渲染 agent 回复（标题/列表/代码块/表格/引用/链接）；默认不渲染原始 HTML（自带 XSS 防护）；用户气泡仍显示纯文本
- 验收：历史会话里的标题、代码块、表格按样式渲染；`<script>` 类内容只显示成文字
- 完成信号：实测网卡会话 74 个代码块 / 27 个表格全部渲染（2026-11-09）

## T11 ✅ 自动拉起 opencode 服务

- 范围：`shell/src/auth.rs`、`src/api/client.ts`
- 内容：`service status` 无地址时自动 `service start`（幂等，150 秒窗口轮询；`where` 探测命令、start 失败带 stderr）；前端 reconnect 超时 300 秒
- 验收：双击 exe 直接连上（服务未跑时自动后台启动）；已有服务时不重复启动
- 完成信号：实测两条路径（2026-11-09）

## T12 ✅ 模型选择 + 停止对话

- 范围：`src/api/chat.ts`、`src/components/Chat.tsx`、`src/components/ChatHeader.tsx`、`src/components/ChatInput.tsx`、`src/hooks/useChatEvents.ts`、`src/styles/panels.css`
- 内容：会话头部加模型下拉（`GET /api/model` + `/api/model/default` 兜底，切换走 `POST /api/session/<id>/model`）；生成中「发送」变「停止」（`POST /api/session/<id>/interrupt`），用 `time.busy > time.idle` 判断生成中
- 验收：切换模型后会话 model 字段变化；耗时任务生成中出现「停止」，点击后 `outcome: interrupted`
- 完成信号：dev 实测通过（2026-11-09），68 个模型可筛选

## T13 ✅ 任意大小文件阅读 + 行虚拟化

- 范围：`shell/src/fsapi.rs` `fsindex.rs` `fsread.rs` `server.rs`、`src/api/localfs.ts`、`src/components/CodeView.tsx` `FileTree.tsx` `codeWindow.ts`、`src/App.tsx`、`vite.config.ts`、`scripts/dev-local-fs.mjs`
- 内容：新增 `/local/fs/*` 本地直读通道（list/stat/read/text/raw/hex，token 门禁与 `/api` 一致、路径限定在 root 内）；一次扫描建「行号 → 字节偏移」稀疏检查点（每 4096 行），分页窗口按行读取；CodeView 改为虚拟滚动（只渲染视口 + 60 行 overscan，按 200 行一页按需加载、最多缓存 24 页）；FileTree 扁平化 + 行虚拟化；Markdown 预览（≤1MB）、图片 blob 预览、二进制 hex 转储；去掉 500KB 预览上限
- 验收：7.2MB/15 万行与 32.5MB/60 万行文件能打开并滚到末行；1.1MB Markdown 预览降级、源码可分页；PNG 预览、EXE 头 hex；5 个文件连续点 40 次无长掉帧；展开 6 个目录后文件树 DOM 行数仍只有 40
- 完成信号：dev（headless Edge + CDP）实测通过（2026-11-09）；dev 中间件与 Rust 语义对齐但存在已知差异（见 docs/api-notes.md §9）；Rust 19 项单测 + 前端 7 项纯函数测试全绿

## T14 ✅ 聊天图片/文件附件

- 范围：`src/components/attachments.ts`、`ChatInput.tsx`、`Chat.tsx`、`MessageList.tsx`、`MarkdownText.tsx`、`src/api/chat.ts`、`src/styles/editor.css`、`markdown.css`
- 内容：输入框支持选择/粘贴/拖入图片（缩略图可删），发送时把 data URL 放进 `POST /api/session/<id>/prompt` 的 `files`；消息里的附件按 `files[].data + mime` 还原成 blob 缩略图，点击全屏放大；agent 回复里的 `data:` 图片直接渲染、工作区内截图路径走 `/local/fs/raw`，远程图片点「点击加载」才请求
- 验收：带图 prompt 返回 200 且 `GET message` 回 `files[{name,mime,data}]`；页面 DOM 出现 `chat-file-img > img[src^=blob:]`；单张 ≤6MB、总量 data URL ≤9MB（外壳 body 上限 10MB），>1.2MB 位图先压 JPEG
- 完成信号：真实 opencode 服务 + headless Edge 实测通过（2026-11-10），44 项前端单测全绿

## T15 ✅ 消息里的文件路径可点击

- 范围：`src/components/fileLinks.ts`、`MarkdownText.tsx`、`MessageList.tsx`、`Chat.tsx`、`CodeView.tsx`、`src/App.tsx`、`src/styles/markdown.css`、`tools.css`
- 内容：反引号、Markdown 链接、正文裸路径都识别成可点按钮（中文正文边界、尾部标点、URL 排除都处理）；支持 `:12` / `:12:5` / `#L12` 行号后缀；点击后在中间栏打开并滚到该行（Markdown 预览态自动切源码、闪行高亮）；工具卡片里的文件路径同样可点
- 验收：点 `src/components/Chat.tsx:300` → `.editor-path` 变 `src/components/Chat.tsx`、`scrollTop=5681`、第 300 行 `.code-line.flash`
- 完成信号：headless Edge + CDP 实测通过（2026-11-10，脚本 `scripts/verify-filelinks.mjs`）；路径识别 6 项 + 附件 9 项单测全绿

## T16 ✅ 审查面板压力测试与修复

- 范围：`src/components/ReviewPanel.tsx`、`diffWindow.ts`、`src/api/vcs.ts`、`src/styles/diff.css`、`scripts/stress-review.mjs`、`scripts/verify-review.mjs`
- 内容：diff 行做虚拟滚动（固定行高 18px，只渲染视口 ±40 行）；文件列表做虚拟滚动（固定 26px）；`fetchStatus/fetchDiff` 支持 AbortSignal，连点刷新先掐旧请求；patch 按 `
?
` 切分去掉 Windows 的 `
`；加载中补「读取改动中…」
- 验收：401 文件 / 5.4MB diff / 单文件 60005 行的夹具（`.tmp/stress-repo`）上：首帧 3676ms→927ms、DOM 62492→378、堆 60MB→27.6MB；滚到中间看到 huge_9955、滚到底看到 huge_29999（位置无错位）；滚动 16ms/帧；列表滚到底出现 module_399
- 完成信号：headless Edge + CDP 实测（2026-11-10）；正常仓库（67 个改动文件）复测 681ms、切换文件正常；49 项前端单测全绿

## T17 ✅ 高优先级评审后的修复

- 范围：`src/hooks/useFilePreview.ts`、`src/components/Chat.tsx`、`attachments.ts`、`src/App.tsx`、`scripts/{verify-fixes,verify-attach}.mjs`；swarm `lib/tower.mjs`、`lib/tower-run.mjs`、`stress-review.mjs`
- 内容：
  1. ≥1MB Markdown 默认停在源码分页（等 stat 到达再判定；手动切过视图后自动规则不再抢）
  2. 附件只发 `uri`，不再重复带 `source`（同一 base64 发两遍时 4MB+ 非图片附件在打包版必被 413）
  3. 图片压缩提前到体积校验之前（8MB 截图压到 2.1MB 能加入），压缩前挡 32MB 原始文件
  4. 停在审查视图时点聊天路径 / 文件树 → 自动切回代码视图
  5. tower 评审结论改用一次性 nonce（`VERDICT-<nonce>`），互相矛盾的结论按不通过处理
  6. `clampDiffDetailed` 多文件按「前 K 个文件」截断，500 文件也守住 1.05 倍预算
  7. 抽出 `reviewOutcome` 纯函数，补 review→state→merge 的接线测试
- 验收：2.3MB `.md` 打开是 97 行源码（`preview=false`、无关闭提示）；8.16MB PNG 压到 2.1MB 后加入附件；审查视图点 `README.md` 后 `reviewActive=false`、编辑器显示该文件；swarm 27+27+19+22 全过，workbench 49 项全过
- 完成信号：dev（headless Edge + CDP）实测 2026-11-10（`scripts/verify-fixes.mjs`、`scripts/verify-attach.mjs`）

## T18 ✅ 代码补全（本地词法 + 同目录符号）

- 范围：`src/components/completion.ts`（新）、`src/components/CodeEditor.tsx`、`src/styles/editor.css`、`scripts/completion.test.mjs`（新）
- 内容：编辑态输入时弹补全浮层，候选 = 当前文件符号（函数/类/变量/类型/import）+ 同目录文件符号
  + 语言关键字 + import 路径；`Tab`/`Enter` 接受、`↑↓`/`PgUp/PgDn` 选择、`Esc` 只关浮层不退出编辑、
  `Ctrl+Space` 手动叫出；`=`/`.` 触发成员补全；字符串里 `./` 触发路径补全；滚动即关闭，避免位置漂移
- 实现要点：符号每 200ms 去抖重算（>400KB 只在挂载时算）、同目录索引限 40 个文件 / 单个 128KB；
  浮层定位抽成 `popupPlacement` 纯函数（行号列 68 + 内边距 12 + 列×字符宽，靠右夹紧、靠底翻到上方）
- 验收：在真实工作台里打开一个 `.cs` 文件，输入 `con` 弹出 `const/continue` 与同目录符号，`Tab` 后该行变成 `const`；
  输入 `loadConfig.` 弹成员候选且本文件符号排第一；`Esc` 关浮层后编辑器仍在、再 `Esc` 退出编辑
- 完成信号：`tsc --noEmit` + `npm test` 86 项全过（新增 completion 24 项）；`dist` 与 release exe 重建并重启
  实测 2026-11-11（WebView2 CDP 驱动真实界面，见 `.tmp/cdp-check.mjs` 的验证输出）

## T19 ✅ 会话状态灯 + 会话标签栏

- 范围：`src/components/sessionLight.ts`（新）、`ChatTabs.tsx`（新）、`src/hooks/useSessionLights.ts`（新）、
  `ChatHeader.tsx`、`Chat.tsx`、`App.tsx`、`ProjectTabs.tsx`、`projectStatus.ts`、`src/styles/panels.css`、
  `scripts/sessionLight.test.mjs`（新）、`.tmp/verify-panes.mjs`（新）
- 内容：
  1. 会话列表每条前面加状态灯：跑着 = 呼吸黄、空闲 = 常亮绿、上一轮报错 = 红、未连接 = 灰；
     顶部会话标题按钮上也有一颗，切走以后仍然能看出这条会话在不在跑
  2. 一次轮询喂两种灯：`useSessionLights` 每 1.5 秒拉一次全局会话列表（一个请求），
     既给顶栏项目灯，也给会话列表和标签栏。删掉原来只喂项目灯的 `useProjectRunning`
  3. 会话标签栏：聊天区顶部排标签，每条标签一个会话、带状态灯和 ×，+ 号加新标签（最多 6 个）；
     列表右侧的 ⧉ 把某条会话开成标签，已开就跳过去。同一时刻只渲染一个 Chat，
     宽度全给当前会话，不是把 500px 切成两半；标签配置落 localStorage、按项目分开存
  4. Chat 的「会话历史重拉」与「会话列表变化」拆开：原来 `sessions` 在依赖里，
     轮询一刷就每 1.5 秒重拉一遍历史
- 验收：`.tmp/verify-panes.mjs` 全绿——三条会话三色灯正确、跑完 6 秒内黄灯自己变绿（真轮询不是快照）、
  点 ⧉ 多出一个标签且自动激活、只渲染一个聊天区（确认不是并排）、标签上有灯、点标签能切会话、
  × 能关标签、配置落盘；全量 `npm test` 393 项 + `tsc --noEmit` 通过
- 完成信号：headless Edge + CDP 实测 2026-11-13（截图 `.tmp/verify-panes.png`）
- 踩坑：
  1. `editor.css` 在 `main.tsx` 里比 `panels.css` 后加载，同优先级写 `.chat-header` 会被覆盖、
     看着「改了没效果」，必须用 `#root` 提优先级
  2. `ChatTabs` 一开始漏传 `lights` 给 `Chat`，结果数据层已经是 idle、界面永远停在打开那一刻的旧灯色；
     这类「props 少接一根线」端到端看灯色变化才抓得到，tsc 和单测都发现不了
  3. CDP 里 `localStorage` 按源隔离：在 about:blank 写再导航过去读不到，必须先落到目标源再写

## T20 ✅ 修复 opencode 识别问题（shim 脚本）

- 根因：npm/bun 装的 opencode 在 PATH 里落的是 `opencode.cmd`（或同名无扩展名 bash 脚本）。
  旧代码对定位到的路径直接 `Command::new(path)`，Windows 对 `.cmd` 走 CreateProcess 会失败，
  表现为「已安装，版本读取失败：os error 193」。实测：直接 spawn `.cmd` 得 EINVAL，经 `cmd /C` 得 `opencode v2.3.0`。
- 内容（`shell/src/auth.rs`、`shell/src/cli.rs`）：
  1. `classify()` 用「扩展名 + 文件头是否 MZ」判定 shim，`pick_runnable()` 把非 PE 的候选换成同目录 `.exe`/`.cmd`
  2. `command_for_path()` 对 shim 走 `cmd /C`，`exe_version()` 改成用它（不再直接 exec）
  3. `install_target()` 只在「定位到的是真 PE」时原地升级，否则装到同一个目录的 `opencode.exe`
  4. `status_json()` 装完后重算 `installed`/`path`/`version`/`newer`，避免「路径有了、状态还是未安装」
- 验收（真机）：debug 版起 `OC_WORKBENCH_DEBUG_PORT` → `/local/cli/status` 返回
  `installed=true, version="2.3.0", path="...\.local\bin\opencode.cmd", error=null`，界面顶栏显示 `oc 2.3.0`；
  Rust 测试 144 项全过（含 `version_probe_goes_through_cmd_for_shim`）

## T21 ✅ 查看运行中的子智能体

- 范围：`src/components/SubagentPanel.tsx`、`src/components/subagent.ts`、`src/api/chat.ts`、`src/App.tsx`、
  `src/styles/panels.css`、`scripts/subagent.test.mjs`
- 内容：右侧面板按 `parentID` 逐层爬子会话（最多 3 层），列出状态/标题/耗时/token/花费；
  只给「在跑」的最多 8 个拉消息显示当前工具；跑超过 5 分钟标「卡住？」；点一行跳到那个子会话；
  三档轮询（有在跑的 1.2s / 都结束了 5s / 一个都没有 8s），并跳过 15 秒内确认过没有子孙的空闲子会话
- 验收（真机，`opencode` 会话有 8 个子智能体）：面板列出 8 行、汇总「2 个在跑 / 共 8 个」、
  在跑行显示当前工具与参数、耗时 122h 的两行带「卡住？」，点一行能跳进该子会话；
  请求速率由 8.8 req/s 降到 6.5 req/s

## 上述两项复审中修掉的问题

- 🔴 `pickActivity` 取到的是**最旧**的工具：服务端消息倒序（索引 0 最新）、消息内 part 正序，
  旧实现从数组尾部往前扫 → 面板显示子智能体最开始用的 `skill`，实际当前是 `shell`。
  改成按时间戳取最新（时间相同再按位置），补 `scripts/pickActivity.test.mjs` 5 项回归
- 🔴 点进子智能体后标题丢失：子会话不在顶层会话列表里，头部显示「会话」、标签显示「新会话」。
  改成按 id 补查 `getSession`，并通过 `onSessionInfo`/`onSessionRunning` 上报给标签栏
- 🟡 标签栏漏传 `lights`（T19 遗留），界面灯不刷新
- 🟡 面板每轮为每个子会话问一次孙子，8 个子智能体时 8.8 req/s → 加「确认无子孙」的 15 秒缓存 + 三档轮询

## 待评估

- LSP 接入（Monaco + typescript-language-server）：目前是本地词法补全，LSP 只用来补「类型级成员/签名」
- 内置浏览器 / 图片预览
- 独立的系统窗口（每个会话一个 OS 窗口）：T19 做的是同一窗口内的标签栏，跨窗口还没做
- 交互式终端（需要 x-opencode-ticket + WebSocket 代理）
- 401 自动重连
- 会话列表深翻页（当前 12 页封顶，240 条以上目录可能漏）
