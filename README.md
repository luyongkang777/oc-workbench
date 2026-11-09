# oc-workbench

OpenCode 工作台：Rust + WebView2 桌面外壳，内嵌前端，自带本地 HTTP 服务与 `/api` 反向代理。
双击 exe 即可用，不依赖浏览器、不需要先开终端。

## 功能

| 区域 | 能力 |
|---|---|
| 左栏 | 文件树（懒加载，过滤 node_modules/dist/target），点文件在中间打开；标题栏「打开」可切换任意文件夹（重启记住） |
| 中间 | 源码查看（带行号）；顶栏「审查」切换到工作区改动（A/M/D + patch 着色） |
| 右栏 | 会话面板：切会话、新建、发消息、流式回复、工具调用卡片 |
| 底部 | 命令终端：一条条执行（`cmd.exe /c`），显示输出和退出码，支持中文 |

## 运行原理

1. 启动时执行 `opencode service status` 找服务；**服务没跑就自动 `opencode service start`**
   （后台拉起，最多等约 2 分半——比 opencode 自己的 2 分钟启动预算多留 30 秒；`service start` 幂等，已有服务时立刻返回，不会重复启动）
2. 执行 `opencode pair` 拿一次性配对链接，用 `Accept: text/html` 换到 `Set-Cookie`
3. 起本地 HTTP 服务（`127.0.0.1:<随机端口>`）：静态页面 + `/api` 反代（自动注入 cookie）
4. WebView2 加载本地页面；页面通过 IPC 向外壳要 API token（token 不走 HTTP，外部进程拿不到）
5. 后端没起来不白屏：页面照常渲染，显示「未连接」，后台每 5 秒重试

## 开发

```powershell
npm.cmd install
npm.cmd run dev          # http://127.0.0.1:5273，dev 代理自动配对
```

dev 模式想连本地 opencode 服务时不用额外配置；想连别的地址要显式设置：

```powershell
$env:OC_WORKBENCH_URL = "http://127.0.0.1:5273"
```

## 打包

顺序不能反：`dist` 被 gitignore，`include_dir!` 是编译期嵌入。

```powershell
npm.cmd run build          # 生成 dist（缺了 cargo build 会直接报错提示）
cd shell
cargo build --release      # 产物 shell/target/release/oc-workbench-shell.exe

打包后必须确认 **exe 的修改时间晚于 dist/index.html**（exe 是编译期把 dist 嵌进去的）：

```powershell
Get-Item dist\index.html, shell\target\release\oc-workbench-shell.exe | Select-Object LastWriteTime
```

反过来就说明 exe 里是旧前端：重新 `npm run build`，再 `cargo build --release`。
```

## 目录

```
src/            前端（Vite + React + TS）
  api/          对 opencode API 的封装（client/chat/terminal/vcs）
  components/   FileTree / CodeView / Chat / ReviewPanel / Terminal
  styles/       拆分的样式（base/panels/editor/terminal/diff）
shell/          Rust 外壳（tao + wry / WebView2 + tiny_http）
  src/main.rs   窗口、IPC（token 下发）、导航限制
  src/server.rs 路由、Host/token 校验、后端自愈
  src/proxy.rs  /api 反代（含 SSE 手写 flush）
  src/body.rs   请求体读取（10MB 上限 + 15s 超时）
  src/auth.rs   发现服务 + 配对换 cookie（错误串里配对链接会打码）
specs/workbench/ 需求、任务、进度
docs/           接口实测笔记
```

## 已知限制

- 源码查看只读，不能编辑保存
- 终端是「命令终端」，不是交互式 shell（PTY 的 WebSocket 需要额外 ticket，当前客户端只有 cookie）
- 会话里回复的 Markdown 原样显示，未渲染
- 工作区改动只支持 `mode=working`（未提交的改动），没有分支对比
- 会话列表最多翻 12 页（240 条），更早的会话可能看不到
- 服务由 exe 自动拉起后会常驻后台（关掉工作台窗口不会停止它，下次启动直接复用）
- 机器上找不到 `opencode` 时直接报「未安装/不在 PATH」，不会空等启动窗口
