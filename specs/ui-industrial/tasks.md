# tasks（ui-industrial）

> 粒度硬指标：每条 ≤ 5 个文件、≤ 300 行改动、一次会话内可完成并独立验收。

## T1 图标系统：32 个图标重绘为正交几何线框

- 文件：`src/components/Icon.tsx`
- 内容：替换 `PATHS` 全部路径；`IconDefs` 与 `Icon` 的 `strokeWidth` 由 1.8 改为 1.5。
- 验收：`tsc --noEmit` 通过；调用点零改动；图标在 14/16px 下仍成形。
- 状态：完成

## T2 暗色 token：冷哑光炭黑体系

- 文件：`src/styles/base.css`（`:root` 块）
- 验收：正文对比 ≥ 10:1；`npm test` 全绿。状态：完成

## T3 浅色 token：哑光纸感体系

- 文件：`src/styles/base.css`（`:root[data-theme='light']` 块）
- 验收：正文对比 ≥ 12:1；主题切换无残留色。状态：完成

## T4 圆角 / 阴影 / 等宽字体 token

- 文件：`src/styles/base.css`
- 内容：`--r-*` → 2/3/4/6；新增 `--mono`。状态：完成

## T5 验收：三层校验

- `tsc` / `npm test` / `css-check` / `npm run build` 四条全绿。状态：完成（665/665）

## T6 强调色按钮对比度（审查追加）

- 文件：`editor.css`、`terminal.css`、`panels.css`、`account.css`
- 内容：5 处「accent 填充 + 浅色字」统一 `var(--text-inverse)`。状态：完成

## T7 顶栏 5 图标重画 + 账号图标区分

- 文件：`src/components/Icon.tsx`、`src/components/TopBar.tsx`
- 内容：
  - `sun`：射线靠近圆心（旧版间隙 3.2px，15px 下像散点）
  - `shield`：对勾放大居中
  - `plug`：改成正交外壳 + 双插脚 + 引线（旧版弧形外壳像钥匙）
  - `gauge`：半圆表盘在 15px 下断成两段 → 改三根柱状（用量语义更准）
  - `monitor`：底座加宽，去「T 字」感
  - 新增 `account` 图标（头肩剪影）：主题（跟随系统）和账号原来都是显示器，并排重复
  - 顶栏图标 15px → 16px
- 验收：4× 放大截图逐个可辨、5 个图标互不重复。状态：完成

## T8 exe 图标 + 窗口图标

- 文件：`design/app-icon.svg`（母版）、`shell/icon.ico`、`shell/icon64.rgba`、
  `scripts/embed-exe-icon.mjs`、`scripts/build-exe.mjs`、`shell/src/main.rs`
- 内容：
  - 母版：暗色圆角瓦片 + 冷青六棱柱 + `> _` 提示符；≤40px 用实心六棱柱，≥48px 用线框
  - 9 档尺寸（16/20/24/32/40/48/64/128/256）打包成 PNG-ICO
  - 资源注入走 Win32 `BeginUpdateResource`（本机没有 rc.exe，winres/embed-resource 用不了）
  - 窗口图标用 `include_bytes!("../icon64.rgba")` + `with_window_icon`（exe 资源只影响资源管理器）
  - 构建流水线第 2.5 步自动注入，改图标不必手工跑
- 验收：`ExtractAssociatedIcon` 抽得出图标；窗口 `WM_GETICON` 返回 64×64 本方图标。状态：完成

## 待评估（本次不做）

- 顶栏/控件高度从 26/30 收紧到 24/28（牵动手机端底部占比压测）
- 代码区字体直接指定 JetBrains Mono（本机未装，现在靠 Cascadia 兜底）
- macOS/Linux 图标（当前只做 Windows）
