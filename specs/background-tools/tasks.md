# tasks — 后台化阻塞工具

一条一条做，做完验证通过才开下一条。每条 ≤ 5 个文件、≤ 300 行。

## B1 — 接入 background 端点

- 范围：`src/api/chat.ts`、`src/components/ChatInput.tsx`、`src/components/Chat.tsx`、`src/styles/panels.css`
- 内容：
  1. `chat.ts` 加 `backgroundSession(sessionID)` → `POST /api/session/{id}/background`（204 空 body 安全）。
  2. `ChatInput.tsx` 加 `onBackground` prop，running 时在「停止」旁渲染 `.chat-send.ghost`「后台」。
  3. `Chat.tsx` 加 `moveToBackground()`，成功后给 `chat-notice ok` 提示；透传 `onBackground`。
  4. `Chat.tsx` 加 window `Ctrl+B`：排除 textarea/input/contenteditable，仅 running 时触发。
  5. `panels.css` 加 `.chat-send.ghost` 样式（中性色，和「停止」的红区分开）。
- 验收：tsc + npm test 绿；dev + CDP 五条断言通过。
- 完成信号：`.chat-send.ghost` 真能点、提示出现、Ctrl+B 在输入框外生效。

## 待评估

（执行中发现的额外问题记这里，不在本次做）
