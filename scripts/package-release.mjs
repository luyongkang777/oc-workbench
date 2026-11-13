// 打发布包：node scripts/package-release.mjs
//
// 前置：先跑 `npm run build:exe`（前端 → dist → 编译期内嵌进 exe），本脚本只做
// 「核对 + 目录 + 说明 + 校验和 + zip」，不重复编译，避免两份产物不一致。
//
// 为什么核对这么啰嗦：dist 被 gitignore，include_dir! 是编译期嵌入。dist 旧了，
// exe 里就是旧前端，而文件时间戳照样会更新——肉眼看不出问题，测出来的是幻觉。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const exe = path.join(root, 'shell', 'target', 'release', 'oc-workbench-shell.exe')
const distIndex = path.join(root, 'dist', 'index.html')
const outName = `oc-workbench-${version}-win64`
const outDir = path.join(root, 'release', outName)
const zipPath = path.join(root, 'release', `${outName}.zip`)

const say = (line) => process.stdout.write(`${line}\n`)
const fail = (message) => {
  process.stdout.write(`\n✗ ${message}\n`)
  process.exit(1)
}

if (!existsSync(exe)) fail(`没有 ${exe}：先跑 npm run build:exe`)
if (!existsSync(distIndex)) fail('没有 dist/index.html：先跑 npm run build:exe')

const exeTime = statSync(exe).mtimeMs
const distTime = statSync(distIndex).mtimeMs
if (exeTime < distTime) {
  fail(
    `exe 比 dist 旧（exe ${new Date(exeTime).toLocaleString()} < dist ${new Date(distTime).toLocaleString()}），` +
      '里面是旧前端，重跑 npm run build:exe',
  )
}

// 前端资源必须真在 exe 字节里（嵌入成功），否则发出去的包一点开就是白屏。
const html = readFileSync(distIndex, 'utf8')
const assets = [...html.matchAll(/\/assets\/([A-Za-z0-9._-]+)/g)].map((match) => match[1])
const binary = readFileSync(exe)
const missing = assets.filter((name) => !binary.includes(name))
if (missing.length > 0) fail(`exe 里找不到前端资源：${missing.join('、')}`)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// 交付名去掉 -shell：用户看到的是产品名，不是内部 crate 名
const shipped = path.join(outDir, 'oc-workbench.exe')
copyFileSync(exe, shipped)

const guide = `OpenCode 工作台 v${version}（Windows x64）
=====================================

一、这是什么
  一条桌面工作台：左边看文件、中间读代码、右边和 OpenCode 对话、底部执行命令。
  只有一个 exe，前端已经嵌进去，不需要装 Node，也不需要先开终端。

二、运行环境
  * Windows 10 1809+ / Windows 11（64 位）
  * WebView2 运行时：Windows 11 与较新的 Win10 自带。
    如果双击后弹窗提示缺少 WebView2，按弹窗里的地址装一次即可（微软官方安装包）。
  * opencode 命令行（AI 侧）。没装也能打开界面浏览文件，只是顶栏显示「未连接」。

三、第一次打开
  1. 把 oc-workbench.exe 放到一个固定目录（例如 D:\\Tools\\oc-workbench\\），双击。
  2. 首页点「打开文件夹」，选一个项目目录。
  3. 之后每次启动自动打开上次的项目；顶栏标签可切多个项目。
  4. 也可以把文件夹直接拖到 exe 图标上，或用顶栏的「＋」。

四、opencode 装在哪能被找到
  查找顺序：
    1) 环境变量 OC_WORKBENCH_OPENCODE（完整路径或命令名）
    2) PATH
    3) exe 所在目录（绿色版：把 opencode.exe 放在旁边）
    4) %USERPROFILE%\\.local\\bin
    5) %USERPROFILE%\\.opencode\\bin
    6) %LOCALAPPDATA%\\Programs\\opencode
    7) %APPDATA%\\npm
  装在别处：设置环境变量 OC_WORKBENCH_OPENCODE=完整路径\\opencode.exe，再重开本程序。
  完全找不到时，首页会直接写出「查过哪些位置」，不用猜。

五、数据和日志
  * 项目清单、上次打开的目录、运行日志都在：%LOCALAPPDATA%\\oc-workbench\\
      projects.json   项目列表与每个项目的界面状态
      root.txt        上次打开的目录
      gui-error.log   启动/连接/崩溃日志
  * 连不上后端时先看 gui-error.log，里面记着每次尝试的具体原因。
  * opencode 服务由本程序自动拉起；关掉窗口不会停掉它，下次启动直接复用。

六、在线更新
  * 顶栏右侧有版本号（例如 v1.1.0），点它打开「版本与更新」。
  * 第一次用要先填「更新源」：一个 latest.json 的地址（http/https）。
      latest.json 的格式：
        { "version": "1.1.1", "url": "https://你的服务器/oc-workbench-1.1.1-win64.exe",
          "sha256": "…", "size": 3486720, "notes": "这次改了什么" }
  * 点「检查更新」：有新版本会显示版本号、体积和说明；点「立即更新」会
    下载 → 校验 SHA256 → 关闭窗口 → 覆盖 exe → 自动重新启动。
  * 旧版本会备份成 oc-workbench.exe.bak，出问题改名回去即可。
  * 程序所在目录必须可写（放在 Program Files 里更新会失败，建议放用户目录）。
  * 只有点检查/更新时才联网；也可以用环境变量 OC_WORKBENCH_UPDATE_URL 指定更新源。

七、卸载
  删掉 exe 和 %LOCALAPPDATA%\\oc-workbench 目录即可。不写注册表、不留后台服务。

八、常见问题
  * 双击没反应：看 %LOCALAPPDATA%\\oc-workbench\\gui-error.log。
  * 白屏：多为 WebView2 缺失或被杀软拦截，装/放行后重开。
  * 一直「未连接」：日志里会写是找不到 opencode、还是 pair 失败（配对链接已打码）。
  * 窗口关掉后 opencode 还在跑：这是设计——下次启动更快，需要停就 opencode service stop。
  * 更新时提示「程序所在目录不可写」：把 exe 挪到有写权限的目录（例如 D:\Tools\）。
  * 更新后想回退：把 oc-workbench.exe.bak 改名成 oc-workbench.exe 覆盖回去。
`

// 文件名保持 ASCII：中文名在不同解压工具/代码页下会变成乱码，内容里已经全中文
writeFileSync(path.join(outDir, 'README.txt'), guide, 'utf8')

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const exeHash = sha256(shipped)

// 在线更新清单：客户端拉它比对版本，再按 url 下载、按 sha256 校验。
// 下载地址必须写成绝对地址（客户端不知道服务器在哪），用环境变量给：
//   $env:OC_WORKBENCH_DOWNLOAD_BASE = "https://你的域名/oc-workbench"
// 两种托管都能直接用：
//   OC_WORKBENCH_GITHUB=owner/repo   → 走 GitHub Release 资产地址（推荐）
//   OC_WORKBENCH_DOWNLOAD_BASE=...   → 走任意静态目录
const githubRepo = (process.env.OC_WORKBENCH_GITHUB || '').trim().replace(/^\/+|\/+$/g, '')
const tag = `v${version}`
const downloadBase = githubRepo
  ? `https://github.com/${githubRepo}/releases/download/${tag}`
  : (process.env.OC_WORKBENCH_DOWNLOAD_BASE || '').trim().replace(/\/+$/, '')
const downloadUrl = downloadBase ? `${downloadBase}/${outName}.exe` : `${outName}.exe`
const notesPath = path.join(root, 'RELEASE_NOTES.md')
const notes =
  (process.env.OC_WORKBENCH_NOTES || '').trim() ||
  (existsSync(notesPath) ? readFileSync(notesPath, 'utf8').trim() : '')
const manifest = {
  version,
  url: downloadUrl,
  sha256: exeHash,
  size: statSync(shipped).size,
  notes,
  publishedAt: new Date().toISOString(),
}
const manifestPath = path.join(root, 'release', 'latest.json')
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}
`, 'utf8')
writeFileSync(
  path.join(outDir, 'SHA256SUMS.txt'),
  `${exeHash}  oc-workbench.exe\n`,
  'utf8',
)

// 用 PowerShell 的 Compress-Archive 打包：Windows 上不需要额外的 zip 依赖
if (process.platform === 'win32') {
  rmSync(zipPath, { force: true })
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path '${outDir}\\*' -DestinationPath '${zipPath}' -Force`,
    ],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) fail('打 zip 失败（Compress-Archive 退出码非 0）')
}

const sizeMb = (statSync(shipped).size / 1024 / 1024).toFixed(2)
say('')
say(`✓ ${shipped}`)
say(`  ${sizeMb} MB  构建于 ${new Date(exeTime).toLocaleString()}`)
say(`  SHA256 ${exeHash}`)
if (existsSync(zipPath)) {
  const zipMb = (statSync(zipPath).size / 1024 / 1024).toFixed(2)
  say(`✓ ${zipPath}（${zipMb} MB，SHA256 ${sha256(zipPath)}）`)
}
say(`✓ ${manifestPath}`)
if (!downloadBase) {
  say('')
  say('! 清单里的 url 是相对路径：上传时请设置 OC_WORKBENCH_GITHUB=owner/repo')
  say('  （或 OC_WORKBENCH_DOWNLOAD_BASE）重新打包')
} else if (githubRepo) {
  say('')
  say(`GitHub 发布：把 ${outName}.exe、latest.json 传到 ${githubRepo} 的 ${tag} release`)
  say('  客户端默认源指向 releases/latest/download 别名，发版后自动生效')
}
say('')
say('把整个文件夹（或 zip）拷到另一台机器，双击 oc-workbench.exe 即可。')
say('在线更新：把 latest.json 和 exe 传到同一目录，客户端更新源指向 latest.json 即可。')
