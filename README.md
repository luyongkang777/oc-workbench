# oc-workbench

OpenCode 工作台：Rust + WebView2 桌面外壳，内嵌前端，自带本地 HTTP 服务与 `/api` 反向代理。
双击 exe 即可用，不依赖浏览器、不需要先开终端。

## 功能

| 区域 | 能力 |
|---|---|
| 左栏 | 文件树（懒加载，过滤 node_modules/dist/target），点文件在中间打开、双击打开并编辑；**右键菜单**：新建文件（带 `.c` / `.cpp` / `.cc` / `.cxx` / `.h` / `.hpp` / `.txt` / `.md` / `.json` / `.py` / `.js` / `.ts` / `.html` / `.css` / `.java` / `.go` / `.rs` 类型预设）、新建文件夹、重命名、删除（目录递归删除先确认；动到打开中的文件会先确认未保存改动）；标题栏「打开」可切换任意文件夹（重启记住） |
| 中间 | 代码/文档查看：任意大小文件按行分页 + 虚拟滚动（只渲染视口几十行）；工具栏按行号跳转（Ctrl+G 聚焦，显示当前首行）、Ctrl+F 整文件搜索（命中计数/高亮/上下跳）；**源码可编辑**（≤2MB）：**双击代码**或双击文件树进入编辑，Ctrl+S 原子保存、带 mtime 冲突检测（409 提示重新加载）、保留原文件 BOM 与 CRLF，未保存时切文件/切目录会先确认；编码支持 UTF-8（含 BOM）/ UTF-16LE / UTF-16BE / GBK（无 BOM 时按「合法 UTF-8 → 否则 GB18030」判定）；工具栏的编码下拉**非编辑态＝以该编码重新打开**（可选「自动」回到探测），**编辑态＝保存编码**，也可以只换编码不改文本直接保存；文件树可手动刷新、窗口聚焦自动刷新；Markdown 预览（≤1MB）、图片预览、二进制十六进制转储；顶栏「审查」切换工作区改动（A/M/D + patch 着色，文件列表与 patch 都做了虚拟滚动，6 万行 diff 也只渲染 80 行左右）；**代码补全**：编辑时输入即弹（本文件符号 + 同目录文件符号 + 语言关键字 + import 路径），`Tab`/`Enter` 接受、`↑↓`/`PgUp/PgDn` 选择、`Esc` 只关浮层不退出编辑、`Ctrl+Space` 手动叫出；`.` 后给成员、字符串里 `./` 给路径 |
| 右栏 | 会话面板：切会话、新建、发消息、流式回复、工具调用卡片；模型下拉支持按模型选「思考强度」（variant），思考过程（reasoning 段）实时显示、结束后可展开回看；「选择模式」把 question 工具的问题渲染成选项卡片（单选/多选/自定义输入/跳过）；输入框输入 `/` 弹出斜杠命令菜单（内置命令 + 服务端命令，↑↓ 选择、Enter/Tab 确认、Esc 关闭，`/agents` 二级切换 agent）；图片/文件附件：点「＋图片」选、直接粘贴截图、或把文件拖进输入区，缩略图可删，发出去后消息里显示图片（点击全屏放大）；agent 回复里的 `data:` 图片和本地截图路径也会直接渲染；**消息里的文件路径可点**（反引号、Markdown 链接、正文裸路径都认），带 `:12` / `#L12` 的会打开并在中间栏跳到那一行 |
| 底部 | 命令终端：一条条执行（`cmd.exe /c`），显示输出和退出码，支持中文 |

## 运行原理

1. 启动时执行 `opencode service status` 找服务；**服务没跑就自动 `opencode service start`**
   （后台拉起，最多等约 2 分半——比 opencode 自己的 2 分钟启动预算多留 30 秒；`service start` 幂等，已有服务时立刻返回，不会重复启动）
2. 执行 `opencode pair` 拿一次性配对链接，用 `Accept: text/html` 换到 `Set-Cookie`
3. 起本地 HTTP 服务（`127.0.0.1:<随机端口>`）：静态页面 + `/api` 反代（自动注入 cookie）
   + `/local/fs/*` 本地文件通道（直接读磁盘，不经过 opencode；同一道 `x-oc-token` 门禁）
4. WebView2 加载本地页面；页面通过 IPC 向外壳要 API token（token 不走 HTTP，外部进程拿不到）
5. 后端没起来不白屏：页面照常渲染，显示「未连接」，后台每 5 秒重试；
   文件树与文件查看走本地通道，后端断开也能照常浏览

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

旧 exe 正在运行时会报 `os error 5`（拒绝访问）。关掉窗口再编译，或临时用独立目录：

```powershell
$env:CARGO_TARGET_DIR = "$PWD/shell/target-rel"
cargo build --release
# 产物：shell/target-rel/release/oc-workbench-shell.exe，关掉旧实例后覆盖即可
```
```

## 目录

```
src/            前端（Vite + React + TS）
  api/          对 opencode API 的封装（client/chat/terminal/vcs）+ localfs（本地文件）
  components/   FileTree / CodeView / Chat / ReviewPanel / Terminal
                codeWindow.ts 是虚拟滚动的纯计算（行高/页大小/可见区间，可单测）
                turns.ts 是消息分组与思考段（reasoning）的纯计算，可单测
                attachments.ts 是聊天附件的规则与压缩（数量/体积上限、大图压 JPEG），可单测
                diffWindow.ts 是审查面板的 diff 虚拟滚动窗口计算，可单测
                localPath.ts 把 Markdown 里的本地图片路径转成相对工作区路径，可单测
                fileLinks.ts 从正文认出文件路径与行号后缀（中文正文边界也认），可单测
                QuestionForm.tsx 是选择模式（question 表单）；formState.ts 是答案状态纯计算，可单测
                completion.ts 是代码补全的纯逻辑（上下文识别/抽符号/排序/写回/浮层定位），可单测
                ChatInput.tsx 的斜杠菜单用 chatCommands.ts（内置命令/过滤/解析/合并），可单测
  styles/       拆分的样式（base/panels/editor/terminal/diff）
shell/          Rust 外壳（tao + wry / WebView2 + tiny_http）
  src/main.rs   窗口、IPC（token 下发）、导航限制
  src/server.rs 路由、Host/token 校验、后端自愈
  src/proxy.rs  /api 反代（含 SSE 手写 flush）
  src/body.rs   请求体读取（10MB 上限 + 15s 超时）
  src/auth.rs   发现服务 + 配对换 cookie（错误串里配对链接会打码）
  src/fsapi.rs  /local/fs/* 本地文件接口（list/stat/read/text/raw/hex，路径越界校验）
  src/fsindex.rs 行索引（一次扫描 + 每 4096 行一个检查点，按 size+mtime 缓存）
  src/fsread.rs 按行窗口读取（UTF-8/UTF-16、CRLF 归一、超长行截断）、hex 转储
scripts/        dev 本地文件中间件（与 Rust 同语义）、大文件 CDP 实测脚本
specs/workbench/ 需求、任务、进度
docs/           接口实测笔记
```

## 已知限制

- 源码编辑：上限 2 MB；编码支持 UTF-8 / UTF-16LE / UTF-16BE / GBK（GBK 走 Windows 代码页 54936，
  dev 模式下 GB18030 四字节字符——emoji 等——不支持，会提示改用 UTF-8）；二进制文件仍只读
  保存时若文件已被别处改过（mtime 不一致）会提示重新加载，不会静默覆盖
- 终端是「命令终端」，不是交互式 shell（PTY 的 WebSocket 需要额外 ticket，当前客户端只有 cookie）
- Markdown 全文预览上限 1 MB（再大 react-markdown 自己会卡）：**超过 1 MB 默认停在源码分页模式**，
  手动点「预览」才会提示并保持源码，源码模式可看任意大小
- 代码补全不依赖语言服务器：候选来自当前文件 + 同目录文件符号 + 关键字 + import 路径，**没有类型信息**（`obj.` 后给的是本文件符号，不是该对象真正的成员）；同目录索引限 40 个文件、单个 ≤128KB，跨目录符号不进候选；要类型级补全需接 LSP
- 图片预览上限 64 MB；二进制文件只显示前 4 KB 十六进制
- 聊天附件走 base64 内联（opencode 的 prompt 只认 `uri`，不再重复带 `source`）：**压缩后**单张 ≤ 6 MB、
  一次总量 ≤ 9 MB；超过 1.2 MB 的位图先压 JPEG（最大边 2000、质量 0.88）再校验，原始 32 MB 以上不读进内存；
  历史消息里的图片点了才渲染大图
- 远程 Markdown 图片默认不自动加载，要点「点击加载图片」才请求（避免历史会话静默外联）
- 审查面板一次拉整个工作区 diff（opencode 接口不支持按文件过滤），超大改动首个响应要等后端跑 git diff
  （401 文件 / 5.4MB 实测约 0.6 秒）；渲染侧已虚拟化，不会因行数多而卡死
- 工作区改动只支持 `mode=working`（未提交的改动），没有分支对比
- 会话列表最多翻 12 页（240 条），更早的会话可能看不到
- 服务由 exe 自动拉起后会常驻后台（关掉工作台窗口不会停止它，下次启动直接复用）
- 机器上找不到 `opencode` 时直接报「未安装/不在 PATH」，不会空等启动窗口
