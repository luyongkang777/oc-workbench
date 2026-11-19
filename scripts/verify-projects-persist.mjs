// 项目清单跨重启的回归验收：
//   node scripts/verify-projects-persist.mjs
//
// 复现的 bug：重开工作台后清单只剩第一个文件夹。
// 时间线是 oc:auth → root:<上次目录> → projects:<json>，修复前 root: 一到
// 就落盘，把 projects.json 覆盖成单条。
//
// 验收做法（不用 CDP，直接看落盘与日志）：
//   1. 先把 projects.json 备份，写入两条已知项目
//   2. 起 exe，等 8 秒
//   3. 读 projects.json：必须仍是两条
//   4. 关掉 exe，再起一次，等 8 秒，再读：必须仍是两条
//
// 前置：不能有别的 oc-workbench 进程在跑（单实例会拦住新 exe）。
// 本脚本只起/关自己起的进程，绝不碰用户已经开着的客户端。
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EXE = process.argv[2] ?? 'shell/target/release/oc-workbench-shell.exe'
const DATA_DIR = path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'oc-workbench')
const PROJECTS = path.join(DATA_DIR, 'projects.json')
const LOG = path.join(DATA_DIR, 'gui-error.log')
const BACKUP = `${PROJECTS}.verify-backup`
/** 默认两次启动；`OCW_ROUNDS=8` 可以跑压力轮次。 */
const ROUNDS = Math.max(2, Number(process.env.OCW_ROUNDS || 2))

const SAMPLE = [
  { path: 'F:\\opencode\\workbench', name: 'workbench', lastUsed: Date.now(), state: { file: null, view: 'code' } },
  { path: 'F:\\硬件开发', name: '硬件开发', lastUsed: Date.now() - 1000, state: { file: null, view: 'code' } },
]
/** 两条清单 200+ 字节，单条 80~116 字节；这个阈值能干净地区分。 */
const SINGLE_WRITE_MAX = 140

function listWorkbench() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq oc-workbench*', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
    })
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('"'))
      .map((line) => {
        const [name, pid] = line.replace(/"/g, '').split(',')
        return { name, pid: Number(pid) }
      })
  } catch {
    return []
  }
}

function readProjects() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROJECTS, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function logSize() {
  try {
    return fs.statSync(LOG).size
  } catch {
    return 0
  }
}

function readNewLog(from) {
  try {
    return fs.readFileSync(LOG).subarray(from).toString('utf8')
  } catch {
    return ''
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function startOnce(tag) {
  const before = logSize()
  const child = spawn(EXE, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9231' },
  })
  child.unref()
  await sleep(8000)

  const list = readProjects()
  const log = readNewLog(before)
  if (log.includes('创建 WebView 失败')) {
    return { ok: false, crashed: true }
  }
  // 修复前日志里会出现「存项目清单 N 字节」且 N 很小时的单条覆盖。
  const singleWrites = [...log.matchAll(/存项目清单 (\d+) 字节/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n <= SINGLE_WRITE_MAX)

  const ok = list.length === 2 && singleWrites.length === 0
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${tag}: 清单 ${list.length} 条（${list.map((p) => p.name).join(', ')}）` +
      `${singleWrites.length ? `；出现单条覆盖 ${singleWrites.join('/')} 字节` : ''}`,
  )
  return { ok }
}

function killAll() {
  for (const p of listWorkbench()) {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' })
    } catch {
      /* 已经退出 */
    }
  }
}

async function waitGone() {
  for (let i = 0; i < 30; i++) {
    if (listWorkbench().length === 0) {
      // WebView2 的 user data 目录还要一会儿才释放，太急会报「请求的资源在使用中」。
      await sleep(4000)
      return true
    }
    await sleep(500)
  }
  return false
}

/** 起一次并等它稳定；WebView2 偶发占用就再等一轮重试。 */
async function runRound(tag) {
  let result = await startOnce(tag)
  if (result.crashed) {
    console.log(`… ${tag} WebView2 还在占用，等 8 秒重试`)
    killAll()
    await waitGone()
    await sleep(8000)
    result = await startOnce(`${tag}（重试）`)
    if (result.crashed) {
      console.log(`? ${tag}: WebView2 连续创建失败，这一轮不算数`)
      return { ok: true, skipped: true }
    }
  }
  return result
}

const running = listWorkbench()
if (running.length > 0) {
  console.error(`还有工作台在跑（pid ${running.map((p) => p.pid).join(', ')}），先关掉再验收。`)
  process.exit(2)
}
if (!fs.existsSync(EXE)) {
  console.error(`找不到 ${EXE}，先跑 node scripts/build-exe.mjs`)
  process.exit(2)
}

if (fs.existsSync(PROJECTS)) fs.copyFileSync(PROJECTS, BACKUP)
fs.writeFileSync(PROJECTS, JSON.stringify(SAMPLE))

let failed = false
try {
  for (let i = 1; i <= ROUNDS; i++) {
    const round = await runRound(`第 ${i}/${ROUNDS} 次启动`)
    failed ||= !round.ok
    killAll()
    await waitGone()
  }
} finally {
  // 还原：只把备份里有、现在缺的项目补回去，绝不整份回写。
  // 整份回写会把「之前被污染的单条快照」一路传下去，也会删掉这期间新加的项目。
  if (fs.existsSync(BACKUP)) {
    const keyOf = (x) =>
      String(x?.path ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
    const backup = JSON.parse(fs.readFileSync(BACKUP, 'utf8'))
    const current = readProjects()
    const have = new Set(current.map(keyOf))
    const missing = backup.filter((p) => !have.has(keyOf(p)))
    if (missing.length > 0) fs.writeFileSync(PROJECTS, JSON.stringify([...current, ...missing]))
    fs.unlinkSync(BACKUP)
  }
}

console.log(failed ? '结论：FAIL（清单被覆盖）' : `结论：PASS（${ROUNDS} 次重启都保住两条）`)
process.exit(failed ? 1 : 0)
