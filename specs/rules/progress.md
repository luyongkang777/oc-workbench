# 强制规则 · 进度

## 2026-11-16（第二轮：条目化 + AI 可写）

### 本轮完成

- 规则从「一整块 markdown」改成**条目**：`{ title, text }`
  - 只填内容 = 单行条目；填了标题 = 标题 + 内容两行。
  - 存储改 JSON（全局 / 目录各一份），原子写（临时文件 + rename）。
- 老 `.md` 自动解析成条目并迁移：标题 + 紧跟行 = 两行条目，其余行 = 单行条目；
  第一次保存后改名 `*.md.migrated-<时间戳>` 留档，避免两处并存。
- 新增 AI 工具（用户说「加一条规则」就能写进去）：
  - `rules_add(scope, text, title?)`
  - `rules_update(scope, index, text?, title?)`（`title:""` = 改回单行条目）
  - `rules_remove(scope, index)`
  - `rules_status()`（列条目 + 序号 + 计数）
- 注入正文带序号（scope 内从 1 开始），与工具序号口径一致。
- 面板改成条目列表：每行一个条目卡片（标题输入 + 内容输入 + 删除），
  底部「＋ 单行 / ＋ 标题+内容 / 保存」，实时字节数与覆盖描述。

### 修掉的真 bug

- **插件启动时建空 JSON 会挡住老 `.md`**（读 JSON 优先）→ 升级后全局规则静默变空。
  修法两处：空 JSON（0 字节）视同不存在继续读老 md；启动时若有老 md 内容则解析迁移成 JSON，而不是建空文件。

### 验证

- `npm test`：495 全绿（含 `rulesStatus` 11 条）。
- `cargo test --release`：234 全绿（含 `rules::tests` 5 条）。
- UI 验收 `scripts/verify-rules.mjs`：13/13 PASS（开面板 → 加单行 → 加标题+内容 → 保存 → JSON 落盘 → 删除保存 → Esc）。
- AI 工具端到端：`rules_add` 写入第 2 条 → `rules_status` 看到 → `rules_remove` 删除 → 恢复 1 条。
- `node scripts/build-exe.mjs` 出包成功。

### 当前真实规则（本机）

- 全局 1 条：标题「临时验证规则」+ 内容「每次回答的最后一行写：RULES-INJECTED-CHECK」
- 目录 1 条：「改完必须跑 npm test」

### REVIEW

- 自查：单文件均 <300 行；三处 64KB / 500 条上限一致；老格式解析三端（插件/Rust/dev）同口径且各有单测；
  无 🔴 发现。
