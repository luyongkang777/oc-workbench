# 任务拆分 — 后台 Shell / 终端面板

## T1 接口层

- 新增 `src/api/shells.ts`：`listShells(root)` / `readShellOutput(id, root)` / `killShell(id, root)`。
- `src/api/terminal.ts` 增：`listPtys(root)` / `killPty(id)`。
- 类型：`ShellInfo`（id/status/command/cwd/pid/exit/metadata/sessionID/time）、`PtyInfo`。

验收：tsc 0 错误。

## T2 Shell 列表组件

- 新增 `src/components/ShellSessions.tsx`：轮询列表、状态点、命令摘要、耗时、选中展开输出、kill。
- 空态：没有后台命令时显示提示。

验收：在页面里能列出真实运行中的命令。

## T3 终端列表组件

- 新增 `src/components/PtySessions.tsx`：轮询**会话维度**的终端列表
  （`GET /api/experimental/session/{id}/terminal`）、快照预览、移除。

验收：能列出并 kill 一个持久终端。

## T4 容器改造

- `Terminal.tsx` 改成 tab 容器：`命令` / `后台 Shell` / `终端`，原来的命令块逻辑抽到 `TerminalCommand.tsx`。
- 头部按钮即 tab，默认收起；收起时显示运行中数量角标。

验收：三个 tab 都能切，收起展开正常，手机不溢出。

## T5 验收

- `npm test` 全绿。
- dev + 真服务：跑一条 `ping -n 40`，面板里看到它、看到输出、kill 后消失。

## 待评估（不夹带，本次不做）

- 320px 视口下既有 UI 会横向溢出：`.topbar-right` 宽 369、`.balance-panel` 固定 390。
  本次验收已把溢出断言收窄到终端区域，这两处单独开任务处理。
