# progress — 后台 Shell / 终端面板

## 当前任务

**完成（两轮独立审查 🔴0，测试与真机验收全绿）**

## 记录

- 2026-11-17 定需求。数据源真机确认：
  - `GET /api/shell?location[directory]=ROOT` → 正在跑的命令，`metadata.sessionID` 标明归属会话。
  - `GET /api/shell/{id}/output?...&cursor=&limit=` → 输出分页（按字节 cursor）。
  - `DELETE /api/shell/{id}?...` → 终止并移除（即时生效）。
  - `GET /api/shell/{id}?...` → 单条状态，**跑完后仍能查到 exited + 退出码**；被删则 404。
  - **`POST /api/session/{id}/shell` 是同步的**：命令跑完才返回 204，执行期间会出现在列表里。
  - 持久终端必须走会话维度：`GET /api/experimental/session/{id}/terminal`、
    `GET /api/experimental/persistent-pty/{ptyID}/snapshot`、`DELETE /api/experimental/persistent-pty/{ptyID}`。
  - **顶层 `/api/pty` 是另一套管理器**：它的 id 交给 persistent-pty 的 DELETE 会 404，不能混用。
- **T1~T4 完成**：`api/shells.ts`、`ShellSessions`、`PtySessions`、`Terminal` 三 tab 容器、
  `TerminalCommand`（原命令块）、`styles/shell-panel.css`。
- **第一轮审查** 🔴1 🟡5 🟢5 → 全部处理（见下「修复记录」）。
- **第二轮复验** 🔴0 🟡5 🟢8 → 5 个 🟡 全部处理：
  1. 验收脚本 PTY 建在「最新会话」而面板列「当前会话」→ 面板加 `data-session`，脚本改用它。
  2. `settleGone` 把任何异常当「已清理」→ 区分「404/终态」与「请求失败（unknown，保持原状）」。
  3. 输出/快照轮询 catch 后不再续 → 瞬时错误续、`ShellGoneError`/「已经不在了」才停。
  4. 单函数超 50 行 → 继续拆：`useShellKill`、`usePtyKill`、`PtyBody`、`TerminalTabBar`、
     `executeCommand`、`shellMerge.ts`；现在全部 ≤50 行（实测 42~49）。
  5. 隐藏面板仍轮询 → `PtySessions` 加 `visible` 门控；`ShellSessions` 只停输出轮询、
     列表保留（收起时 tab 上的「运行中数量」角标依赖它）。
  另修 3 个 🟢：主动终止后 404 红字（`goneExpected`）、pty 404 文案、换会话立即清空列表。
- 补了 `scripts/shellMerge.test.mjs`（5 条）覆盖合并规则：终态不被 running 覆盖、
  新条目并入、裁剪优先保 running、裁剪同步删缓存、服务端终态能更新本地。

## 踩过的坑

1. **`find` 按命令文本匹配会误伤自己**：脚本的命令行本身可能含探针字符串（heredoc 会进
   shell 的 command 字段），DELETE 时选中它等于把自己杀了（`Shell.NotFoundError`）。
   正确做法：先记录已有 id，POST 后取「新增 id」。
2. **本地终态被服务端旧数据覆盖**：DELETE 生效前 `/api/shell` 可能再返回一次 running。
3. **`/api/pty` ≠ `persistent-pty`**：两套 id 空间，DELETE 会 404。
4. **`hidden` 被 `display:flex` 盖掉**：常驻面板要显式写 `.terminal-pane[hidden]{display:none}`。
5. **面板常驻后选择器要限定**：验收脚本必须用 `.terminal-pane:not([hidden])`。
6. **kill 后 effect 会再拉一次输出**：`isRunning` 从 true→false 触发重跑，撞 404 冒红字；
   要按「是否自己终止的」静默处理。

## 验证

- `tsc --noEmit` → 0 错误。
- `npm.cmd test` → **597 pass / 0 fail**（含新增 5 条）。
- `node scripts/verify-shell-panel.mjs 9233` → **21/21 PASS**。
- 自然结束专项：`ping -n 5` 结束后行内「已退出 · 4.4s」、`shell-dot exited`、详情「退出码 0」、终止按钮禁用。
- 主动终止专项：kill 自己选中的命令后详情区无红字，直接显示「已终止」。
- 行数：ShellSessions 293 / PtySessions 240 / TerminalCommand 190 / Terminal 86 /
  terminal.css 212 / shell-panel.css 167；最大函数 49 行。
