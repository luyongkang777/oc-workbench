# progress（ui-industrial）

## 当前任务

全部完成（T1–T8）

## 任务状态

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| T1 图标系统 32 个重绘 | 完成 | 32 条路径全换、描边 1.8→1.5、脚本校验 32/32 合法 |
| T2 暗色 token | 完成 | `#0d0e11 / #111216 / #181a20 / #1f222b`、主色 `#38bdf8` |
| T3 浅色 token | 完成 | `#f6f7f9` 底 + 纯白面板 + 正文 `#0f131a` + 主色 `#0284c7` |
| T4 圆角/阴影/等宽字体 | 完成 | `--r-*` 2/3/4/6；新增 `--mono` |
| T5 三层校验 | 完成 | `tsc` ✅ `npm test` 665/665 ✅ `css-check` ✅ `npm run build` ✅ |
| T6 强调色按钮对比度 | 完成 | 5 处改 `var(--text-inverse)`，暗色截图文字清晰 |
| T7 顶栏 5 图标重画 + 账号图标 | 完成 | 4× 放大截图逐个可辨；主题/账号不再重复 |
| T8 exe 图标 + 窗口图标 | 完成 | exe 内 9 档图标；窗口 `WM_GETICON` 返回 64×64 本方图标 |

## 审查（change-review-gate）

```
REVIEW: 中 | 🔴0 🟡2 🟢4 | 结论: Approve
```

- 🟡 强调色填充配浅色字（5 处）→ 已统一 `var(--text-inverse)`
- 🟡 顶栏「跟随系统」与「账号」同为显示器图标，并排重复 → 新增 `account` 头肩剪影
- 🟢 `IconName` 只增不改（32 → 33），调用点仅把账号按钮指向新图标
- 🟢 `base.css` 全部 hunk 落在 token 区（第 9–159 行）
- 🟢 token 名单 57 → 58，无丢失，仅新增 `--mono`
- 🟢 Rust 改动只新增 `window_icon()` 与 builder 一行，`cargo build --release` 通过（4 个既有 warning 未增加）

## 视觉验收（真机）

- 图标：`.tmp/icon-sheet.html`（15/16/20/24/32 五档 × 12 个图标）3× 放大逐档检查
- 顶栏：PrintWindow 抓真实 exe 窗口 → 4× 最近邻放大，5 个图标无糊边、互不重复
- App 图标：9 档尺寸对照板；`ExtractAssociatedIcon` 从 exe 抽出 32×32 可见
- 窗口图标：`WM_GETICON small2` 返回 64×64，内容与设计一致

## 坑（本轮新踩）

- 单实例守护会让「重新启动 exe」直接退出，从而探到**旧实例**的窗口 →
  结论错误。判断前必须先看 `StartTime`，或先 `Stop-Process` 再启动。
- tao 的窗口图标（任务栏/Alt-Tab）与 exe 资源图标是两套东西，只注入资源不设置
  `with_window_icon` 时 `WM_GETICON` 返回 0。
- 本机没有 rc.exe，`winres` / `embed-resource` 编译期方案不可用；
  走 `BeginUpdateResource` 才能在构建后改 exe 图标。

## 记录

- 2026-11-18 建立 spec 与任务拆分（Figma page 92:2）
- 2026-11-18 T1–T5 完成，审查通过；追加修复强调色按钮对比度
- 2026-11-18 T7–T8 完成：顶栏 5 图标重画、账号图标独立、exe 与窗口图标落地
