# 任务拆分 — 终端停靠到编辑区

## T1 布局状态

- `useUiLayout` 增：`termOpen`、`termH`（localStorage：`oc-workbench:term-open` / `oc-workbench:term-h`）。
- `App.tsx` 增 `beginTerminalResize`（垂直拖拽，含 zoom 换算、双击复位）。
- `appContext.ts` 暴露上述字段。

验收：tsc 0 错误。

## T2 顶栏开关

- `TopBar` 加终端按钮（`Icon name="terminal"`），active 态跟随 `termOpen`。

验收：点一下开、再点关。

## T3 停靠布局

- `AppShell`：`editor-pane` 内改为「编辑区 + 分隔条 + 终端」纵向布局；删掉底部全宽终端。
- 手机端（`mobile`）保持不显示停靠终端（避免挤压单列布局）。

验收：面板宽度 = 编辑区宽度，不压到侧栏/聊天。

## T4 面板改造

- `Terminal.tsx`：去掉「收起」概念，改由 `termOpen` 控制；头部右侧加统计与关闭按钮。
- 统计：Shell 数量复用 `onCount`；智能体数量用 `listSubagentTree(sessionID)` + `stateOf()`，4 秒一轮。
- Shell 行状态改勾选语义：running=转圈，exit===0=✓，其余=✗。

验收：头部数字与实际一致；命令跑完显示 ✓。

## T5 验收

- `npm test` 全绿。
- 更新 `scripts/verify-shell-panel.mjs`：适配新布局与关闭/拖拽。
