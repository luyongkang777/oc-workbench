# tasks — 后台化阻塞工具

一条一条做，做完验证通过才开下一条。每条 ≤ 5 个文件、≤ 300 行。

## B1 — 接入 background 端点（已完成，v1.7.0）

- 范围：`src/api/chat.ts`、`src/components/ChatInput.tsx`、`src/components/Chat.tsx`、`src/styles/panels.css`
- 内容：
  1. `chat.ts` 加 `backgroundSession(sessionID)` → `POST /api/session/{id}/background`（204 空 body 安全）。
  2. `ChatInput.tsx` 加 `onBackground` prop，running 时在「停止」旁渲染 `.chat-send.ghost`「后台」。
  3. `Chat.tsx` 加 `moveToBackground()`，成功后给 `chat-notice ok` 提示；透传 `onBackground`。
  4. `Chat.tsx` 加 window `Ctrl+B`：排除 textarea/input/contenteditable，仅 running 时触发。
  5. `panels.css` 加 `.chat-send.ghost` 样式（中性色，和「停止」的红区分）。
- 验收：tsc + npm test 绿；dev + CDP 五条断言通过。
- 完成信号：`.chat-send.ghost` 真能点、提示出现、Ctrl+B 在输入框外生效。

## 待评估

- **会话 running 时按 Enter 发不出消息，且没有任何反馈**：`Chat.tsx:1276` 的
  `if (... || busy || runningApi.running) return` 是既有设计（防止偷偷 steer），
  但用户按了回车什么都没发生，容易被当成「键盘坏了」。与本功能无关，
  建议以后给一条提示（「生成中，先停止或等它结束」）或做排队发送。
- **真实按键通道未验**：`Ctrl+B` 在 WebView2 里从 OS → 页面这层有没有被吞掉没测过，
  目前只验了页面 handler 逻辑。要验得在 exe 里做真实按键注入。
