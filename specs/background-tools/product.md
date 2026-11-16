# 需求：把「阻塞工具挪到后台」（opencode 的 Ctrl+B）接进工作台

## 背景

opencode 2.3 的 TUI 里有一个动作 `session.background`（默认绑 `Ctrl+B`）：
会话正在跑、某个工具调用卡住时，把它挪到后台观察，会话立刻解锁，用户可以继续输入。
服务端已经暴露 `POST /api/session/{sessionID}/background`（返回 204，空闲时同样是 204 的 no-op）。

工作台目前只接了 `interrupt` / `compact`，没有这个动作，用户遇到长命令只能等或直接中断。

## 目标

1. 会话正在跑时，输入区多一个「后台」按钮，点了就把阻塞工具挪走。
2. 支持快捷键 `Ctrl+B`（焦点不在输入框里时，避免抢 textarea 的「光标左移」）。
3. 操作成功后给一条明确提示，说清「已挪到后台、结果会自己回来」。

## 不做什么

- 不做「后台任务列表 / 手动取消某个后台任务」——服务端没有对应接口。
- 不判断「到底挪走了几条」——服务端只回 204，没有 body。
- 不改 opencode 本体，只接它的 HTTP 接口。

## 验收标准（可执行）

1. `node node_modules/typescript/bin/tsc --noEmit` 通过。
2. `npm.cmd test` 全绿（不能有 FAIL）。
3. dev 起服务 + Edge CDP：
   - 会话 running 时 `.chat-send.ghost` 存在，文案是「后台」。
   - 点击后出现成功提示（`chat-notice ok`），页面不报错。
   - idle 时按钮不渲染。
   - 焦点在 `.chat-input` 里按 Ctrl+B 不触发（值仍是光标左移）。
   - 焦点在 body 上、会话 running 时按 Ctrl+B 触发。

## 约束

- 只动 4 个文件：`src/api/chat.ts`、`src/components/ChatInput.tsx`、
  `src/components/Chat.tsx`、`src/styles/panels.css`（或 editor.css）。
- 不夹带其他改动。
