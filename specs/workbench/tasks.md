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

## T4 ✅ 编辑器（只读查看；保存未做）

- 范围：`src/components/CodeView.tsx` `src/api/client.ts`
- 内容：只读代码查看（行号 + 虚拟滚动 + 分页读取）；未接 Monaco，也没有 Ctrl+S 保存
- 验收：点文件能看到带行号的源码；大文件按页加载、滚动不卡
- 完成信号：只读闭环（保存能力单列到「待评估」）

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

## 待评估

- LSP 接入（Monaco + typescript-language-server）
- 内置浏览器 / 图片预览
- 多窗口（每个会话一个窗口）
- 交互式终端（需要 x-opencode-ticket + WebSocket 代理）
- 401 自动重连
- 会话列表深翻页（当前 12 页封顶，240 条以上目录可能漏）
