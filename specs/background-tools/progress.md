# progress — 后台化阻塞工具

## 当前任务

**B1 已发布（v1.7.0）**

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
- 2026-11-16 **独立审查（子智能体，只看 diff）**：REVIEW 中 | 🔴0 🟡3 | Comment。
  三条 🟡 全部已处理：
  1. 没有阻塞工具时点它会假提示「已把工具挪到后台」——文案改成条件句
     「已请求后台化：有卡住的命令会转到后台继续跑，你可以接着输入」。
  2. 验收脚本兜底选「任意标签页」会把开发者正在用的浏览器导航走并改 localStorage——
     改成找不到 5273 页面直接报错退出。
  3. Ctrl+B 用合成 KeyboardEvent 只能证明 handler 逻辑，真实按键通道未覆盖——已在脚本里注明边界。
- 2026-11-16 **v1.7.0 已发布**：CI 绿（release run 43799675876），
  Release 三资产齐全（非 draft / 非 prerelease），`latest.json` 的
  version/url/sha256/size/notes 与 exe 资产逐项对齐；Gitea 镜像已同步。

## 真机功能实测（2026-11-16，dev + Edge CDP）

不是只验 UI，是让模型真跑一条 `Start-Sleep -Seconds 90` 看会话到底能不能解锁。

**实验组（点「后台」）**：发 prompt → 12 秒确认仍在 running → 点「后台」→ **2.0 秒**后解锁 →
立刻能发出下一条消息并收到 OK → 第 3 轮模型汇报「跑完了，退出正常……已收到完成通知，
退出状态 completed，耗时 90 秒」，后台结果确实回到了对话。

**对照组（全程不点）**：同样的 prompt，running 从 0.5s 一路持续到 **94.9 秒**（命令跑完才结束）。

**结论**：按钮真实价值 = 把这段干等从 94.9s 压到 2.0s（省约 93 秒）。
模型会把我们注入的合成提示转述成「harness 自己把命令转后台了」——它看不到 UI，
把「用户请求」理解成 harness 行为，属正常表述，不是 bug。

脚本：`.tmp/test-bg-live.mjs`（实验组）、`.tmp/test-bg-control.mjs`（对照组）。

## 验证

- `node node_modules/typescript/bin/tsc --noEmit` → 0 错误。
- `npm.cmd test` → pass 484 / fail 0。
- `cargo test --release`（shell/）→ 229 passed / 0 failed。
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
- 🟢 服务端 204 无 body，`backgroundSession` 拿不到条数，提示文案已按条件句写，不虚报。
