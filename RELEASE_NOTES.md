- 1.2.2：找不到 git 时**自动下载便携版 MinGit**（约 50 MB，来自 git-for-windows 官方 Release）解压到 `%LOCALAPPDATA%\oc-workbench\git`，不需要管理员、不用你手动装；面板会轮询，装完自动恢复
- 1.2.2：git 定位加了 **PATH 直扫兜底**——不再只靠 `where` 子进程（它被安全软件拦/超时就会误判成「没装」），并把候选命中情况写进日志
- 1.2.1 补丁：Git 面板的错误条上加了「重试」按钮（装完 git 不用满面板找刷新）；首次调用 git 时把实际使用的路径写进 `gui-error.log`（`[git] 使用 …`），方便对照「同一个版本，为什么这台机器不行」
- 1.2.1 补丁：确认 1.2.0 已带 git 定位修复——若你看到的是「400 找不到 git 命令：program not found」，那是更新前那个进程的旧提示，刷新/重启后不会再出现

- 修「400 找不到 git 命令：program not found」：git 改为「环境变量 → PATH → 常见安装位置」定位（Git for Windows、GitHub Desktop 自带、scoop、chocolatey、绿色版），没装时给可操作的提示而不是原始系统错误
- 更新检查不再每次启动都发请求：静默检查最多 6 小时一次（上次时间记在 localStorage），点开面板才立即查
- 顶栏挂载时的 CLI 状态改为纯本机读取（`latest=0`），完全不联网；CLI 自动更新同样节流到 6 小时一次（没装的情况立即装）
- 新增 OpenCode CLI 版本显示：顶栏胶囊显示 `oc 2.2.5`，没装显示 `oc 未装`，需要装/更新时变品牌色
- 新增 CLI 自动安装与自动更新：后台检查，没装就装 v2、装了有新版就更新（`settings.json` 的 `autoUpdateCli`，默认开）
- 「版本与更新」面板下半部分新增 CLI 区块：本机版本、路径、最新 v2、安装/更新按钮、下载进度条、自动更新开关
- 安装链路：GitHub 发布列表（只认 v2.x.y）→ zip 下载（体积 + PK 头校验）→ 系统 tar 解压（退回 PowerShell）→ 新文件 `--version` 校验 → 改名换文件（运行中的 exe 也能换，留 `.bak-<版本>`）
- 后端装的是 v1 也会被判为「该装 v2」：v1 协议与工作台不兼容
- 新增 10 个 Rust 单元测试（版本解析/比较、发布包挑选、嵌套查找 exe、替换与备份）与 8 个前端文案测试
- 新增接口：`GET /local/cli/status`、`POST /local/cli/install`、`POST /local/cli/check`、`POST /local/cli/auto`

- 新增「启动时自动检查更新」开关：关掉后启动不再外联，只在点开更新面板时检查
- 开关状态存在 settings.json 的 autoCheckUpdate，默认开；与更新源、跳过版本互不影响
- 修掉一个启动竞态：令牌还没经 IPC 下发时读配置会 403，导致关掉的自动检查被兜底重新打开
