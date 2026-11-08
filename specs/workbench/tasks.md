# tasks — OpenCode 工作台

规则：一次只做一条，做完验证通过才开下一条。每条 ≤ 5 个文件、≤ 300 行。

## T1 接口实测

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

## T2 前端骨架

- 范围：`package.json` `vite.config.ts` `index.html` `src/main.tsx` `src/App.tsx`
- 内容：Vite + React + TS；dev 代理 `/api` 到 opencode 服务；三栏布局 + 底部终端占位
- 验收：`npm run dev` 打开后 3 秒内看到三栏；顶部有连接状态
- 完成信号：页面能跑，无控制台报错

## T3 文件树

- 范围：`src/api/client.ts` `src/components/FileTree.tsx` `src/App.tsx`
- 内容：调 `/api/fs/list` 懒加载目录，点击文件回调
- 验收：展开 `F:\opencode\workbench` 能看到真实文件；点文件能拿到路径
- 完成信号：树可展开两级以上

## T4 编辑器

- 范围：`src/components/Editor.tsx` `src/api/client.ts`
- 内容：Monaco 打开文件（`/api/fs/read`），Ctrl+S 保存（`/api/experimental/fs/write`）
- 验收：改一行保存后 `Get-Content` 能看到新内容
- 完成信号：保存成功提示

## T5 会话面板

- 范围：`src/components/Chat.tsx` `src/api/client.ts` `src/hooks/useEvents.ts`
- 内容：会话列表/新建、发消息、SSE 订阅流式内容
- 验收：发"列出当前目录的文件"能看到流式回复与工具卡片
- 完成信号：不刷新页面能收到增量

## T6 终端

- 范围：`src/components/Terminal.tsx`
- 内容：xterm.js 接 `/api/pty`
- 验收：能执行 `echo hello` 并显示输出
- 完成信号：输入输出正常，窗口缩放正常

## T7 diff 审查

- 范围：`src/components/DiffView.tsx` `src/api/client.ts`
- 内容：`/api/vcs/status` + `/api/vcs/diff`，Monaco DiffEditor 展示
- 验收：agent 改文件后能列出变更并看到增删
- 完成信号：点变更文件能看到 diff

## T8 桌面壳

- 范围：`src-tauri/*` 或 `electron/*`（按 T2 结论定）
- 内容：打包成单窗口桌面程序，启动时自动拉起/连接本地服务
- 验收：双击 exe 能打开界面并连上后端
- 完成信号：无需手动开终端

## 待评估

- LSP 接入（Monaco + typescript-language-server）——等 T8 完成后再评估
- 内置浏览器 / 图片预览
- 多窗口（每个会话一个窗口）
