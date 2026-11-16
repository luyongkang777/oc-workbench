# 强制规则 · 任务拆分（条目化）

| # | 任务 | 文件 | 状态 |
|---|---|---|---|
| 1 | 条目模型：`{title,text}`、归一化、老 md 解析、渲染带序号 | `plugins/rules/core.mts` | done |
| 2 | 存储改 JSON（全局 + 目录），原子写，首次保存迁移老 md | `core.mts` | done |
| 3 | AI 写规则工具：`rules_add` / `rules_update` / `rules_remove` / `rules_status` | `plugins/rules/index.ts` | done |
| 4 | 注入与闸门改用条目正文；`/rules` 列条目 | `index.ts` | done |
| 5 | 外壳接口改条目（JSON 读写 + 老 md 兼容解析） | `shell/src/rules.rs` | done |
| 6 | dev 同款接口（含 `parseLegacyMarkdown`） | `scripts/dev-local-rules.mjs` | done |
| 7 | 前端类型/纯函数改条目（`normalizeItems` / `toDrafts` / coverage） | `src/components/rulesFormat.ts` | done |
| 8 | 接口层 `saveRule(scope, dir, items)` | `src/api/rules.ts` | done |
| 9 | 面板改条目列表（每行一条，标题可选，增删改） | `src/components/RulesPanel.tsx` | done |
| 10 | 条目列表样式 | `src/styles/rules.css` | done |
| 11 | 单测改条目口径（11 条） | `scripts/rulesStatus.test.mjs` | done |
| 12 | UI 验收改条目口径（13 条） | `scripts/verify-rules.mjs` | done |

## 待评估

- 拖动排序（当前只能删了重加）。
- 条目级启用/停用（用户明确要「强制」，暂不做开关，只做「删除条目」）。
