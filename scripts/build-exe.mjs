// 一条命令出 exe：node scripts/build-exe.mjs
//
// 为什么必须是这个顺序：dist 被 .gitignore 忽略，壳里用 include_dir! 在编译期
// 把 dist 整个嵌进二进制。dist 旧了，exe 里就是旧前端，但文件时间戳照样更新，
// 肉眼看不出问题。所以这里在编完之后再做一次核对：
//   1) exe 的 mtime 必须不早于 dist/index.html
//   2) dist/index.html 里引用的每个 asset 文件名都要能在 exe 字节里找到
// 两条任一不满足就退出码非 0，别让人拿着一个嵌了旧包的 exe 去测。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const shellDir = path.join(root, 'shell')
const exe = path.join(shellDir, 'target', 'release', 'oc-workbench-shell.exe')
const distIndex = path.join(root, 'dist', 'index.html')

const isWin = process.platform === 'win32'

function say(line) {
  process.stdout.write(`${line}\n`)
}

function fail(message) {
  process.stdout.write(`\n✗ ${message}\n`)
  process.exit(1)
}

/** 跑一条命令，stdio 直通，失败就带着命令原文退出。 */
function run(command, args, cwd, extraEnv) {
  say(`▸ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  })
  if (result.error) {
    fail(`${command} 起不来：${result.error.message}`)
  }
  if (result.status !== 0) {
    const hint = result.status === 5 || result.status === 3221225794
      ? '\n  目标 exe 被锁住了：可能有以管理员身份跑着的实例，用管理员权限重跑本脚本即可。'
      : ''
    fail(`${command} 退出码 ${result.status}${hint}`)
  }
}

/** cargo 不一定在本进程的 PATH 里（从 IDE / bash 里调起来时经常没有）。 */
function cargoPath() {
  const probe = spawnSync('cargo', ['--version'], { encoding: 'utf8' })
  if (!probe.error && probe.status === 0) return 'cargo'
  const fallback = path.join(homedir(), '.cargo', 'bin', 'cargo.exe')
  if (existsSync(fallback)) return fallback
  fail('找不到 cargo：装 Rust 工具链，或把 %USERPROFILE%\\.cargo\\bin 加进 PATH')
}

/**
 * 列出同名进程（带完整路径）。
 *
 * `Path` 对提权进程可能取不到（访问被拒），那种条目 path 为空，后面按路径
 * 比对时自然不会被误杀。
 */
function listRunning() {
  const query = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-Process -Name oc-workbench-shell -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.Path)" })',
    ],
    { encoding: 'utf8' },
  )
  if (query.error || query.status !== 0) return null // 查不到就算了，别挡构建
  return (query.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, ...rest] = line.split('|')
      return { pid: Number(pid), path: rest.join('|') }
    })
    .filter((item) => Number.isInteger(item.pid) && item.pid > 0)
}

/**
 * 编之前把占用目标 exe 的实例关掉。
 *
 * 旧实例开着，cargo 链接会以 os error 5 失败。以前只打一行警告让人自己关，
 * 实际迭代时常常忘了，就有人靠「把旧 exe 改名」绕过去——留下一个易混淆的
 * 旧文件，下次还容易跑错。这里直接结束占用进程，等句柄真的释放再编。
 *
 * 只杀路径等于本次目标的实例：target 和 target-rel 各有一份同名 exe，
 * 按进程名杀会把另一份也一起干掉。
 */
function stopRunning() {
  if (!isWin) return
  const norm = (value) => path.resolve(value).toLowerCase()
  const mine = (item) => Boolean(item.path) && norm(item.path) === norm(exe)

  const listed = listRunning()
  if (!listed) return

  const targets = listed.filter(mine)
  if (targets.length === 0) {
    if (listed.length > 0) {
      say(`· 另有 ${listed.length} 个同名实例在跑（不是本次要覆盖的文件），保留。`)
    }
    return
  }

  for (const item of targets) {
    say(`▸ 结束占用目标 exe 的进程：PID ${item.pid}（${item.path}）`)
    spawnSync('taskkill', ['/PID', String(item.pid), '/F'], { stdio: 'ignore' })
  }

  // 进程退出和文件句柄释放不是同一时刻：轮询到它真的消失再开始编译
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const left = (listRunning() ?? []).filter(mine)
    if (left.length === 0) {
      say('  占用已释放')
      return
    }
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 120'])
  }
  say('! 目标 exe 仍被占用（可能权限不足）：链接大概率会失败（os error 5）')
}

// --check-only：只跑第 3 步核对，不重新构建（给 CI / 排查用）
const checkOnly = process.argv.includes('--check-only')
if (checkOnly) say('（--check-only：只核对现有 exe，不重新构建）')

// 1. 前端
if (!checkOnly) {
  if (isWin) run('cmd.exe', ['/c', 'npm', 'run', 'build'], root)
  else run('npm', ['run', 'build'], root)
}
if (!existsSync(distIndex)) fail('前端没有产出 dist/index.html')

// 2. 壳
if (!checkOnly) {
  const cargo = cargoPath()
  // 到这一步才关旧实例：前端构建不碰 exe，别提前把用户正在用的窗口关掉。
  // 链接阶段文件被锁就没法覆盖，以前靠改名绕过去、留下容易误跑的旧文件，
  // 这里改成直接结束占用进程。
  stopRunning()
  run(cargo, ['build', '--release'], shellDir)
}
if (!existsSync(exe)) fail(`没有产出 ${exe}`)

// 3. 核对 exe 里到底嵌了什么
const distTime = statSync(distIndex).mtimeMs
const exeTime = statSync(exe).mtimeMs
if (exeTime < distTime) {
  fail(
    `exe 比 dist 旧（exe ${new Date(exeTime).toLocaleString()} < dist ${new Date(distTime).toLocaleString()}），` +
      '里面是旧前端，重新跑一次 build-exe。',
  )
}

const html = readFileSync(distIndex, 'utf8')
const assets = [...html.matchAll(/\/assets\/([A-Za-z0-9._-]+)/g)].map((m) => m[1])
const binary = readFileSync(exe)
const missing = assets.filter((name) => !binary.includes(name))
if (missing.length > 0) {
  fail(`exe 里找不到前端资源：${missing.join('、')}`)
}

const size = (binary.byteLength / 1024 / 1024).toFixed(2)
say('')
say(`✓ ${exe}`)
say(`  ${binary.byteLength.toLocaleString()} 字节（${size} MB），${new Date(exeTime).toLocaleString()}`)
say(`  内嵌资源：${assets.join('、') || '（无）'}`)
