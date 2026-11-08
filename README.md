# oc-workbench

OpenCode 工作台：Rust + WebView2 桌面外壳，内嵌前端，自带本地 HTTP 服务与 `/api` 反向代理。

## 现在有什么

- 左侧文件树（`/api/fs/list`，过滤 node_modules/target/dist）
- 中间只读源码查看，带行号（`/api/fs/read`）
- 右侧会话面板占位
- 顶部连接状态（`/api/info`）
- 单文件 exe，不依赖 Vite；启动时自动 `opencode pair` 换 cookie

## 目录

```
src/            前端（Vite + React + TS）
shell/          Rust 外壳（tao + wry / WebView2 + tiny_http 代理）
specs/workbench/ 需求、任务、进度
docs/           接口实测笔记
```

## 开发

```powershell
npm.cmd install
npm.cmd run dev          # 前端 http://127.0.0.1:5273
cd shell; cargo build    # 产物 target/debug/oc-workbench-shell.exe
```

## 打包

```powershell
npm.cmd run build        # 生成 dist，会被 include_dir 内嵌进 exe
cd shell; cargo build
```

exe 启动时会：`opencode service status` 找端口 → `opencode pair` 换 cookie → 起本地服务并加载页面。
找不到后端时回退到 `OC_WORKBENCH_URL`（默认 `http://127.0.0.1:5273`）。
