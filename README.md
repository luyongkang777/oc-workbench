# oc-workbench

OpenCode 工作台：Rust + WebView2 桌面外壳，内嵌前端，自带本地 HTTP 服务与 `/api` 反向代理。
双击 exe 即可用，不依赖浏览器、不需要先开终端。

## 功能

| 区域 | 能力 |
|---|---|
| 顶栏 | 项目标签：一个目录一个项目，平铺在顶栏、和「审查」同一行。点标签就切过去，每个项目记着自己打开的文件和视图，切回来接着上次的位置。末尾「＋」选文件夹加新项目；标签上的 × 只从列表移除（不动磁盘）。从资源管理器把文件夹拖到 exe 上/带路径启动，也会直接成为项目。项目再多也只是标签区横向滚动，不会把右侧按钮挤出去。每个标签前有一颗状态灯：AI 在这个项目里生成时呼吸黄，跑完常亮绿（跨项目跟踪，切走标签照样亮） |
| 左栏 | 文件树（懒加载，过滤 node_modules/dist/target），点文件在中间打开、双击打开并编辑；**右键菜单**：新建文件（带 `.c` / `.cpp` / `.cc` / `.cxx` / `.h` / `.hpp` / `.txt` / `.md` / `.json` / `.py` / `.js` / `.ts` / `.html` / `.css` / `.java` / `.go` / `.rs` 类型预设）、新建文件夹、重命名、删除（目录递归删除先确认；动到打开中的文件会先确认未保存改动）；顶栏项目标签的「＋」可打开任意文件夹作为项目（重启记住） |
| 中间 | 代码/文档查看：任意大小文件按行分页 + 虚拟滚动（只渲染视口几十行）；工具栏按行号跳转（Ctrl+G 聚焦，显示当前首行）、Ctrl+F 整文件搜索（命中计数/高亮/上下跳）；**源码可编辑**（≤2MB）：**双击代码**或双击文件树进入编辑，Ctrl+S 原子保存、带 mtime 冲突检测（409 提示重新加载）、保留原文件 BOM 与 CRLF，未保存时切文件/切目录会先确认；编码支持 UTF-8（含 BOM）/ UTF-16LE / UTF-16BE / GBK（无 BOM 时按「合法 UTF-8 → 否则 GB18030」判定）；工具栏的编码下拉**非编辑态＝以该编码重新打开**（可选「自动」回到探测），**编辑态＝保存编码**，也可以只换编码不改文本直接保存；文件树可手动刷新、窗口聚焦自动刷新；Markdown 预览（≤1MB）、图片预览、二进制十六进制转储；顶栏「审查」切换工作区改动（A/M/D + patch 着色，文件列表与 patch 都做了虚拟滚动，6 万行 diff 也只渲染 80 行左右）；**代码补全**：编辑时输入即弹（本文件符号 + 同目录文件符号 + 语言关键字 + import 路径），`Tab`/`Enter` 接受、`↑↓`/`PgUp/PgDn` 选择、`Esc` 只关浮层不退出编辑、`Ctrl+Space` 手动叫出；`.` 后给成员、字符串里 `./` 给路径 |
| 右栏 | 会话面板：切会话、新建、发消息、流式回复、工具调用卡片；模型下拉支持按模型选「思考强度」（variant），思考过程（reasoning 段）实时显示、结束后可展开回看；「选择模式」把 question 工具的问题渲染成选项卡片（单选/多选/自定义输入/跳过）；输入框输入 `/` 弹出斜杠命令菜单（内置命令 + 服务端命令，↑↓ 选择、Enter/Tab 确认、Esc 关闭，`/agents` 二级切换 agent）；图片/文件附件：点「＋图片」选、直接粘贴截图、或把文件拖进输入区，缩略图可删，发出去后消息里显示图片（点击全屏放大）；agent 回复里的 `data:` 图片和本地截图路径也会直接渲染；**消息里的文件路径可点**（反引号、Markdown 链接、正文裸路径都认），带 `:12` / `#L12` 的会打开并在中间栏跳到那一行；**输入框下方两个读数**：左边「N 轮 M 步 · tok/s」、右边「token 总量 · 缓存命中 67%」，悬停或点击展开「会话统计」明细（输入/缓存读/缓存写/输出、模型用时、工具用时、首 token 平均、输出速度）。速度只除以模型写正文的时间，工具等待不摊薄；命中率分母含缓存读自己 |
| 底部 | 命令终端：一条条执行（`cmd.exe /c`），显示输出和退出码，支持中文 |

## 首次启动

双击 exe 后如果没有任何历史记录，会停在首页：点「打开文件夹」选一个目录，之后启动自动打开上次的项目。
首页还会直接显示后端没连上的**具体原因**（例如「找不到 opencode」以及查过哪些位置），不用先点「重试」才看得到。

## 运行原理

1. 启动时定位 `opencode` 命令（顺序）：环境变量 `OC_WORKBENCH_OPENCODE` → PATH → exe 同目录 →
   `%USERPROFILE%\.local\bin` → `%USERPROFILE%\.opencode\bin` → `%LOCALAPPDATA%\Programs\opencode` → `%APPDATA%\npm`。
   **不是只认 PATH**：常见装法（bun/npm 的 `.cmd` shim、官方安装器）都不一定在 PATH 里，只认 PATH 会导致换台机器直接「未连接」。
2. 执行 `opencode service status` 找服务；**服务没跑就自动 `opencode service start`**
   （后台拉起，最多等约 2 分半——比 opencode 自己的 2 分钟启动预算多留 30 秒；`service start` 幂等，已有服务时立刻返回，不会重复启动）
3. 执行 `opencode pair` 拿一次性配对链接，用 `Accept: text/html` 换到 `Set-Cookie`
4. 起本地 HTTP 服务（`127.0.0.1:<随机端口>`）：静态页面 + `/api` 反代（自动注入 cookie）
   + `/local/fs/*` 本地文件通道（直接读磁盘，不经过 opencode；同一道 `x-oc-token` 门禁）
5. WebView2 加载本地页面；页面通过 IPC 向外壳要 API token（token 不走 HTTP，外部进程拿不到）
6. 项目清单也走 IPC：页面发 `oc:projects` 要清单、发 `oc:projects-save:<json>` 存清单，外壳落到
   `%LOCALAPPDATA%\oc-workbench\projects.json`。清单内容（去重/排序/每个项目的界面状态）在前端算，
   外壳只当存储，避免两套规则走偏。端口每次启动都变，所以不放 localStorage
7. 后端没起来不白屏：页面照常渲染，显示「未连接」，后台每 5 秒重试；
   文件树与文件查看走本地通道，后端断开也能照常浏览。
   `GET /api/state` 只读地回「是否连上 / 连到哪 / 最近一次失败原因」，
   断开态下页面每秒探活时顺带问一次，所以失败原因能直接显示出来（不触发配对）
8. 日志与状态：`%LOCALAPPDATA%\oc-workbench\`（`projects.json` / `root.txt` / `gui-error.log`）。
   日志不放 exe 同目录——装到 Program Files 或只读盘时写不进去，出问题就没线索

## 在线更新

顶栏右侧显示版本号（`v1.1.0`），有新版本时带一颗提示点；点开是「版本与更新」面板。

1. 检查：`GET /local/update/check` 拉清单。没配更新源就立刻返回，**不发任何网络请求**
2. 更新：`POST /local/update/apply` 下载 → 校验体积 + SHA256 + PE 头（MZ）→ 写替换脚本 → 本进程退出

清单 `latest.json`（`npm run release` 自动生成）：

```json
{
  "version": "1.1.1",
  "url": "https://你的服务器/oc-workbench-1.1.1-win64.exe",
  "sha256": "63011865e2b9552d…",
  "size": 3486720,
  "notes": "这次改了什么"
}
```

替换脚本落在 `%LOCALAPPDATA%\oc-workbench\update\apply-<pid>.cmd`。它**不等 PID 退出**，
而是反复重试覆盖 exe：能写进去就说明旧进程已经释放了文件。Windows 上自己覆盖自己不允许，
而 `WaitForExit` / `tasklist` 两条现成路子实测都不可靠（前者在目标已退出后继续挂着，更新直接卡住）。
覆盖成功后启动新 exe，旧文件留成 `oc-workbench.exe.bak`（要回退就改名回去）。

更新源优先级：环境变量 `OC_WORKBENCH_UPDATE_URL` → `settings.json` 的 `updateUrl`（面板里也能填）。
发布时给 `OC_WORKBENCH_DOWNLOAD_BASE`（例如 `https://你的域名/oc-workbench`）让清单写出绝对下载地址：

```powershell
$env:OC_WORKBENCH_DOWNLOAD_BASE = "https://你的域名/oc-workbench"
npm.cmd run release     # 产出 exe + README.txt + SHA256SUMS.txt + latest.json
```

把 `latest.json` 和 exe 传到同一个目录，客户端更新源指向 `latest.json` 即可。

### 发布到 GitHub

仓库：<https://github.com/luyongkang777/oc-workbench>（公开）。更新走 Release 资产，
**不用 `api.github.com`**——没有匿名限流，客户端也不需要带 token：

```
https://github.com/luyongkang777/oc-workbench/releases/latest/download/latest.json
```

发版只需要打 tag —— `.github/workflows/release.yml` 会在 `windows-latest` 上跑完：

```powershell
# 先把 package.json 和 shell/Cargo.toml 的版本改成同一个号
git commit -am "release: 1.1.3"
git tag v1.1.3
git push origin main --tags
```

流水线依次：校验 tag 与 package.json 一致 → 前端测试 → 构建 dist → 外壳测试 → 构建 exe
（含"前端真嵌进去了"核对）→ 生成 latest.json → 把 exe / latest.json / zip 传成该 tag 的 Release。

本地手工出包（不上传）也保留：`npm.cmd run build:exe`，再
`$env:OC_WORKBENCH_GITHUB="owner/repo"; npm.cmd run release`。

## 开发

```powershell
npm.cmd install
npm.cmd run dev          # http://127.0.0.1:5273，dev 代理自动配对
```

界面自动化验收用调试版的 CDP 端口（发布版里这段被 `cfg(debug_assertions)` 裁掉，二进制没有调试口）：

```powershell
cd shell; cargo build                   # 非 --release
$env:OC_WORKBENCH_DEBUG_PORT = "9334"   # 然后 http://127.0.0.1:9334/json/list
```

dev 模式想连本地 opencode 服务时不用额外配置；想连别的地址要显式设置：

```powershell
$env:OC_WORKBENCH_URL = "http://127.0.0.1:5273"
```

## 打包

顺序不能反：`dist` 被 gitignore，`include_dir!` 是编译期嵌入。dist 旧了，exe 里就是旧前端，
但文件时间戳照样更新——肉眼看不出问题，所以每一步都要核对。

```powershell
npm.cmd install
npm.cmd run build:exe   # 前端构建 + 壳编译 + 核对 exe 里是否真嵌了新前端（--check-only 只核对不重建）
npm.cmd run release     # 出发布包：release/oc-workbench-<版本>-win64/{exe,README.txt,SHA256SUMS.txt} + 同名 zip
```

`build:exe` 会自己关掉占用目标 exe 的实例（否则链接报 os error 5），并在编完后校验两件事：
exe 的 mtime 不早于 `dist/index.html`、`dist/index.html` 里引用的每个 asset 都能在 exe 字节里找到。
`release` 只做打包不编译（避免两份产物不一致），同样会先跑这两条核对。

旧 exe 正在运行时也可以临时用独立目录编，避免打断本机正在用的窗口：

```powershell
$env:CARGO_TARGET_DIR = "$PWD/shell/target-rel"
cargo build --release
# 产物：shell/target-rel/release/oc-workbench-shell.exe，关掉旧实例后覆盖即可
```

发布包的交付形态就是一个 exe：前端已内嵌，目标机器需要 Windows 10 1809+/11 x64、WebView2 运行时
（Win11 与较新 Win10 自带）和 opencode 命令行，不需要装 Node/Rust。

## 目录

```
src/            前端（Vite + React + TS）
  api/          对 opencode API 的封装（client/chat/terminal/vcs）+ localfs（本地文件）
  components/   FileTree / CodeView / Chat / ReviewPanel / Terminal / WelcomePane（无项目时的首页）
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
  src/auth.rs   定位 opencode（env→PATH→已知安装位置）+ 配对换 cookie（错误串里链接打码）
  src/projects.rs 项目清单落盘（projects.json 原样读写，测试在 projects_tests.rs）
  src/update.rs 在线更新（清单解析/版本比较/下载校验/替换脚本）
  src/fsapi.rs  /local/fs/* 本地文件接口（list/stat/read/text/raw/hex，路径越界校验）
  src/fsindex.rs 行索引（一次扫描 + 每 4096 行一个检查点，按 size+mtime 缓存）
  src/fsread.rs 按行窗口读取（UTF-8/UTF-16、CRLF 归一、超长行截断）、hex 转储
scripts/        dev 本地文件中间件（与 Rust 同语义）、大文件 CDP 实测脚本
                build-exe.mjs 一条命令出 exe（含嵌入核对）；package-release.mjs 出发布包
specs/workbench/ 需求、任务、进度
docs/           接口实测笔记
```

## 已知限制

- 项目清单最多 40 条（按最近使用排序，超出的从最旧开始丢），存 `%LOCALAPPDATA%\oc-workbench\projects.json`；
  从列表移除只是不再显示，磁盘上的目录一点不动。多个窗口各开一个项目时 `root.txt` 是全局的，
  最后关闭的那个决定下次启动打开哪个项目
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
- 找不到 `opencode` 时不会空等启动窗口：首页直接列出**查过哪些位置**，并提示用 `OC_WORKBENCH_OPENCODE` 指定路径。定位只在启动/重试时做一次，缓存成功结果，但不会缓存失败——装完 opencode 点「重试」立刻生效
