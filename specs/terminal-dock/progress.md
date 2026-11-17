# progress — 终端停靠到编辑区

## 当前任务

**完成（两轮独立审查 🔴0）**

## 记录

- 2026-11-17 定需求：终端从全宽底部条改为编辑区底部停靠面板（Cursor 式），
  顶栏按钮开关、拖拽改高度、头部显示运行中智能体/Shell 数量、命令完成以「打勾」为准。
- 2026-11-17 已删除仓库根的 `count30.py` 与 `scripts/review-split.mjs`。
- **T1~T5 全部完成**（详见 tasks.md）。
- **第一轮审查** 🔴1 🟡5 🟢5 → 全部处理（拖拽换算/单例 useUiLayout/会话清零/拆分/ShellMark）。
- **第二轮复验** 🔴1 🟡3 🟢6 → 处理：
  1. 🔴 挪进编辑区时丢了 `key={root}`：切项目后 Shell 缓存串项目，`settleGone` 拿新 root 查旧 id 必然 404，
     把**仍在跑**的命令永久标成「已退出」。已加回 `key={root}`。
     真机验证：workbench 起 `ping -n 60` → 切到 F:\Autojs，列表 0 条；切回后那条仍「运行中 · 7.5s」，
     标记 `shell-dot running spin`。
  2. 🟡 `App.tsx` 390 行 → 拖拽逻辑抽到 `hooks/usePanelResize.ts`（含左右两栏与终端，
     共用光标锁与双击判定），App.tsx 降到 293 行。
  3. 🟡 拖终端时 body 加的是 `resizing`（col-resize 光标）→ 改 `resizing-row`，`.resizing-row` 不再是死代码。
  4. 🟡 与 SubagentPanel 重复轮询 → 保留 6s 独立轮询，注释写明取舍（复用需把数据源提到上层）。
  另修 🟢：zoom 解析失败时退回「渲染高/逻辑高」、`ShellDetail` 的 exit 判空统一成 `== null`、
  `useShellList` 的 refresh 拆出 `pullOnce`（53→45 行）、补 `shellText` 6 条单测。

## 踩过的坑

1. **`hidden` 仍要显式 CSS**：`.terminal-pane[hidden]{display:none}`。
2. **手机断言空转**：尺寸全 0 也能通过 `scrollWidth <= clientWidth + 1`，必须加「尺寸 > 0」并先切编辑栏。
3. **窄栏 tab 被截断**：缩短 tab 文案，数量放统计区，窄时容器查询隐藏标签文字。
4. **editor.css 是 CRLF**：多行锚点匹配失败，按单行 `.editor-pane {` 定位。
5. **拖拽基准必须取实际渲染值**：逻辑值允许超出 max-height，直接用它会先吃掉差值，表现为「拖了不动」。
6. **组件挪位置别丢 `key`**：`key={root}` 不只是性能优化，它是「切项目重置组件内缓存」的唯一手段。

## 验证

- `tsc --noEmit` → 0 错误。
- `npm.cmd test` → **603 pass / 0 fail**（含 shellMerge 5 条 + shellText 6 条）。
- `node scripts/verify-shell-panel.mjs 9233` → **30/30 PASS**（含拖到上限后重开的回归）。
- 切项目专项：见上「第二轮 1」。
- 行数：App 293 / ShellSessions 62 / shellList 186 / shellViews 94 / Terminal 143；
  函数最大 48 行。
