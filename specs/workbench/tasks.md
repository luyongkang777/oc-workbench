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

## T4 ✅ 编辑器（仅只读查看，未接 Monaco / 保存）

- 范围：`src/components/Editor.tsx` `src/api/client.ts`
- 内容：Monaco 打开文件（`/api/fs/read`），Ctrl+S 保存（`/api/experimental/fs/write`）
- 验收：改一行保存后 `Get-Content` 能看到新内容
- 完成信号：保存成功提示

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

## 待评估

- LSP 接入（Monaco + typescript-language-server）
- 内置浏览器 / 图片预览
- 多窗口（每个会话一个窗口）
- 交互式终端（需要 x-opencode-ticket + WebSocket 代理）
- 401 自动重连
- 会话列表深翻页（当前 12 页封顶，240 条以上目录可能漏）
