REVIEW: 中 | 🔴0 🟡0 🟢1 | 结论: Approve

范围：`git status` 全部改动（10 个修改文件 + 11 个新增文件/目录），含插件、外壳、dev 接口、前端、测试、验收脚本。

## 第一轮（广度，按坑表 A 组逐条）

| # | 检查项 | 结论 |
|---|---|---|
| A1 | 接口改了调用方全改 | `saveRule` 改成 `(scope, dir, items)`，唯一调用方 `useRules.save` 与 `RulesPanel` 同步改；`isReadOnlyTool`→`isSafeTool` 唯一调用点在 `index.ts` 已改 |
| A2 | 新文件加进工程 | `shell/src/rules_store.rs` 加进 `main.rs` 的 `mod`；前端新文件全部被 import；`dev-local-rules.d.mts` 补了类型声明（tsc 干净） |
| A3 | 边界与空值 | 序号 `Number.isFinite` + 范围双检；`items` 非数组直接 400（不再当"清空"）；空内容条目归一化丢弃；条目数 >500 拒绝 |
| A4 | 重入状态 | 保存后把基准设为归一化草稿，避免下一次同步误判"磁盘已变" |
| A5 | 错误路径有返回 | Rust 每个 `Err` 分支都 `json_error` + `return`（写临时文件失败清掉残留） |
| A6 | 并发假设 | 临时文件名带 `pid + 纳秒`，两次保存不会互相截断；dev 侧同样 `tmp + rename` |
| A7 | 常量重复 | 64KB / 500 条在三处（插件 / Rust / dev），已加注释互相指认 |
| A8 | 硬编码 | 只有文档化的家目录相对路径，无新增绝对路径 |
| A9 | 顺手改的 | 图标 `shield`、`main.tsx` 样式引入都在 diff 内逐条过 |

## 第二轮（深度，只拿 diff 重读）

发现并修掉 5 处（都已复测）：

| Severity | 位置 | 问题 |
|---|---|---|
| 🟡→已修 | `plugins/rules/core.mts` | 闸门 fail-closed 把 `rules_add/update/remove` 也拦了 → 规则坏了以后谁都修不了。改成放行只读 + `rules_*` |
| 🟡→已修 | `shell/src/rules.rs` | 请求缺 `items` 会被当成"清空"（畸形请求能抹掉强制规则）→ 改成 400 |
| 🟡→已修 | `shell/src/rules.rs` | 临时文件名固定，并发保存互相截断 → 加 `pid+纳秒` |
| 🟡→已修 | `src/components/RulesPanel.tsx` | 首次加载被误判成"用户正在编辑"，磁盘条目永远填不进列表（实测复现）→ 改成「和上次同步基准比」 |
| 🟡→已修 | `src/components/RulesPanel.tsx` | 只填标题不填内容会在保存时被静默丢弃 → 拦住并提示第几条 |
| 🟢 保留 | `plugins/rules/store.mts` | `readDoc` 的 `exists` 推导有多种情形，略显绕，但每条分支都有单测覆盖，暂不重构 |

## 为什么它不会错

- 注入：`context/compaction/generate` 三条 hook 都调同一个 `injectInto`，`event.system` 非数组时直接 return，异常只记日志不炸整轮。
- 闸门：`execute` 包裹是同步判断 + 原样透传，判错也只会多放行一次，不会把调用吞掉（`decision===null` 走原函数）。
- 迁移：空 JSON 视同不存在 → 老 `.md` 仍能读到；保存后 `.md` 改名留档，不存在两份并存。
- 验收隔离：`verify-rules.mjs` 现在跑在 `.tmp/rules-verify-project`，不碰真实规则（这条是踩过"按位置删"误删真实规则后改的）。

## 复测证据

- `npm test` 495 全绿；`cargo test --release` 234 全绿（含 `rules_store::tests` 5 条）。
- `node node_modules/typescript/bin/tsc --noEmit` 干净。
- `scripts/verify-rules.mjs` 13/13 PASS（独立临时目录）。
- 插件拆分后工具链实测：`rules_add` → `rules_status` 看到 → `rules_remove` 恢复。
- `node scripts/build-exe.mjs` 出包成功（4.42MB，内嵌 `index-DifzyLse.js`）。
