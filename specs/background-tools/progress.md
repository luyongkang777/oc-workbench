# progress — 后台化阻塞工具

## 当前任务

**B1 已完成（待提交）**

## 记录

- 2026-11-16 定需求：opencode 服务端已有 `POST /api/session/{id}/background`（204 no-op），
  工作台未接。按 B1 一条任务实现，不动其他功能。
- 2026-11-16 **B1 完成**。
  - `src/api/chat.ts`：新增 `backgroundSession(sessionID)`，走 `POST /api/session/{id}/background`。
    服务端 204 空 body，`call()` 对空文本返回 undefined，实测不抛。
  - `src/components/ChatInput.tsx`：新增 `onBackground` 必填 prop；running 时在「停止」左边渲染
    `.chat-send.ghost`「后台」。
  - `src/components/Chat.tsx`：`moveToBackground()` + `chat-notice ok` 提示；window 上监听 Ctrl+B，
    排除 textarea/input/contenteditable（输入框里那是「光标左移」），仅 running 时接管。
  - `src/styles/panels.css`：`.chat-send.ghost` 中性色（和「停止」的红区分）。
  - `package.json`：加 `verify:background`。
  - 新增 `scripts/verify-background.mjs`（16 条断言）。

## 验证

- `node node_modules/typescript/bin/tsc --noEmit` → 0 错误。
- `npm.cmd test` → pass 484 / fail 0。
- dev + Edge CDP（`node scripts/verify-background.mjs 9233`）→ **16/16 PASS**：
  idle 无按钮、running 有按钮、点击出成功提示、Ctrl+B 在 body 上被接管、
  输入框里的 Ctrl+B 不被接管、手机 390/320 不横向溢出且输入框宽度够。
- 截图核对：`.tmp/bg-1280.png` / `bg-390.png` / `bg-320.png`，三档布局正常
  （手机端输入框独占一行、按钮在第二行，没有穿模）。

## REVIEW

REVIEW: 中 | 🔴0 🟡1 🟢4 | 结论: Approve

- 🟡 连点「后台」会重复发请求。服务端对同一会话是幂等 no-op，无副作用，不修（加 in-flight
  锁会让代码多一层状态，收益低于成本）。
- 🟢 提示不自动消失：与「压缩成功」提示一致，发下一条消息时清掉。
- 🟢 Ctrl+B 只在 running 时接管，idle 时不影响浏览器的默认行为。
- 🟢 手机端 `.chat-send` 的 `margin-left:auto` 让「后台+停止」靠右，视觉可接受。
- 🟢 服务端 204 无 body，`backgroundSession` 拿不到条数，提示文案已按「已请求」写，不虚报。
