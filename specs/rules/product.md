# 强制规则（rules）

## 目标

用户能设置**全局**和**当前目录**两级规则，规则是**一条一条的条目**（单行，或「标题 + 内容」两行），不是一大块正文；两级规则对「AI 生成」和「工具运行」都**强制生效**，没有开关。AI 也要能按用户口头要求直接写规则。

## 不做什么

- 不做「规则开关」。想取消约束只能清空全部条目。
- 不用一整块 markdown 正文作为存储格式（老格式只做只读兼容 + 自动迁移）。
- 不把规则写进用户仓库的 `AGENTS.md`。
- 不做规则市场 / 分享。

## 数据模型

```json
{ "version": 1, "items": [ { "title": "行尾", "text": "只能用 LF" }, { "title": "", "text": "改完必须跑 npm test" } ] }
```

- `title` 空 → 单行条目；`title` 非空 → 标题 + 内容两行。
- `text` 为空的条目在保存时丢弃。
- 存两份：全局 + 当前目录，互不覆盖；上限 500 条 / 64KB。

## 验收标准

1. 顶栏盾牌打开规则面板，可切「当前目录 / 全局」，每条规则一行，能加/改/删。
2. 「＋ 单行」加一条只有内容的；「＋ 标题+内容」加一条两行条目。
3. 保存后落盘为 JSON 条目：
   - 全局 `%USERPROFILE%\.config\opencode\rules\workbench-global.json`
   - 目录 `<项目>\.opencode\rules.json`
4. 老格式 `.md` 自动解析成条目；第一次保存时改名 `*.md.migrated-*` 留档（不能两处并存）。
5. 每次模型请求注入条目正文（带序号），注入次数可在 `rules_status` 看到增长。
6. 每次工具执行前过闸门；规则文件读不出来时 fail-closed（写类工具拒、只读放行）。
7. AI 能写规则：`rules_add` / `rules_update` / `rules_remove` 按 scope 内序号增删改。
8. 单测 11 条、Rust 5 条、UI 验收 13 条全绿；`npm test` / `cargo test` 不回归。

## 已确认的机制事实（2026-11-16 探测 opencode 2.x exe）

| 能力 | 结论 |
|---|---|
| `ctx.session.hook("context" \| "compaction" \| "generate")` | `event.system.push()` 即注入每次模型请求 |
| `ctx.tool.transform(editor.update)` | 换掉工具 `execute` = **真拦截** |
| `tool.hook("execute.before")` | 只观察、返回 void，不能阻断 |
| 会话目录 | `ctx.session.get({sessionID})` → `location.directory` |

## 踩过的坑

- 插件启动时「建空 JSON」会挡住老 `.md`（读 JSON 优先）→ 升级后静默丢规则。修法：空 JSON 视同不存在，且启动时优先解析迁移老 md。
