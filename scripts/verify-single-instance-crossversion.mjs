// 跨版本单实例验收。
//
// 关键：副本名**必须含 oc-workbench**，否则按判定口径它永远不是 peer，
// 测到的只是互斥体而不是守护线程（这是第一版脚本的错）。
//
// 三种跑法都覆盖：
//   A. 机器上已开着工作台 → 我们的副本必须自己退出，且不动已有进程；
//   B. 改名副本同样被挡住（证明认的是 exe 名而不是窗口标题）；
//   C. 用 release/ 里的真老版本（1.3.4，没有单实例代码）当 intruder：
//      先让我们这一份成为主人，再启动老版本，守护线程应在 10 秒内清掉它。
//
// 注意：C 需要本机没有任何工作台在跑。有客户端在跑时会自动跳过并说明原因。
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = 'F:/opencode/workbench'
const exe = `${root}/shell/target/release/oc-workbench-shell.exe`
const oldExe = `${root}/release/oc-workbench-1.3.4-win64/oc-workbench.exe`
const logPath = path.join(process.env.LOCALAPPDATA || '', 'oc-workbench', 'gui-error.log')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readLog = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '')

if (!fs.existsSync(exe)) {
  console.log(`FAIL  找不到 exe：${exe}（先跑 node scripts/build-exe.mjs）`)
  process.exit(1)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ocw-single-'))
// 名字含 oc-workbench：按判定口径会被认成工作台
const copy = path.join(work, 'oc-workbench-copy.exe')
fs.copyFileSync(exe, copy)

function procs() {
  const out = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', maxBuffer: 16e6 })
  const list = []
  for (const line of out.split(/\r?\n/)) {
    const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ''))
    if (cols.length < 2) continue
    // 只看工作台：名字含 oc-workbench（与本项目判定口径一致）
    if (!/oc-workbench/i.test(cols[0])) continue
    list.push({ name: cols[0], pid: Number(cols[1]) })
  }
  return list
}

const checks = []
const check = (n, ok, d = '') => {
  checks.push({ n, ok, d })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`)
}
const skip = (n, why) => {
  checks.push({ n, ok: true, d: `跳过：${why}` })
  console.log(`SKIP  ${n} — ${why}`)
}

async function waitExit(child, ms) {
  let exited = false
  child.on('exit', () => {
    exited = true
  })
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (exited) return { exited: true, elapsed: Date.now() - t0 }
    await sleep(150)
  }
  return { exited: false, elapsed: Date.now() - t0 }
}

function kill(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
  } catch {
    /* 已经退了 */
  }
}

const before = procs()
const logStart = readLog().length
console.log(`开始前工作台进程：${before.map((p) => `${p.name}#${p.pid}`).join(', ') || '无'}`)

// ---------------------------------------------------------------- A / B
// 已有实例在跑时（本机通常是用户的客户端），任何副本都必须自己退出。
if (before.length > 0) {
  const t0 = Date.now()
  const intruder = spawn(copy, [], { stdio: 'ignore' })
  const r = await waitExit(intruder, 12000)
  const seg = readLog().slice(logStart)
  check('已有实例时，副本无法双开', r.exited, `${r.elapsed}ms`)
  check('退出得够快（不是等满超时）', Date.now() - t0 < 10000, `${Date.now() - t0}ms`)
  check('日志说明是「已有实例在运行」', seg.includes('已有实例在运行'))
  const alive = procs()
  check(
    '原有的工作台没被误杀',
    before.every((b) => alive.some((p) => p.pid === b.pid)),
    `now=${alive.map((p) => p.pid).join(',')}`,
  )
  check('进程数没变', alive.length === before.length, `n=${alive.length}`)
} else {
  skip('已有实例时副本退出', '本机当前没有工作台在跑')
}

// ---------------------------------------------------------------- C
// 守护线程：让我们这一份成为主人，再拉起真老版本（1.3.4，无单实例代码），
// 它必须被清掉——这正是「不管什么版本只能开一个」的核心。
if (!fs.existsSync(oldExe)) {
  skip('守护线程清掉后启动的老版本', `找不到老版本 exe：${oldExe}`)
} else if (procs().length > 0) {
  skip(
    '守护线程清掉后启动的老版本',
    '本机已有工作台在跑，成为「主人」会先被它挡住（请先关掉客户端再跑这条）',
  )
} else {
  const logStartC = readLog().length
  const host = spawn(copy, [], { stdio: 'ignore' })
  const hostPid = host.pid
  let hostExited = false
  host.on('exit', () => {
    hostExited = true
  })
  await sleep(4000)
  check('主人实例启动成功', !hostExited, `pid=${hostPid}`)

  const old = spawn(oldExe, [], { stdio: 'ignore' })
  const oldExit = await waitExit(old, 15000)
  // 进程退出后守护线程还要再写一行「对方已正常退出」（实测晚约 100ms），
  // 直接读会读到「发现另一个工作台」而没有结果行——那是脚本竞态，不是功能坏。
  let segC = readLog().slice(logStartC)
  for (let i = 0; i < 40; i += 1) {
    if (/对方已正常退出|已强制结束对方|对方的窗口已关闭/.test(segC)) break
    await sleep(100)
    segC = readLog().slice(logStartC)
  }

  check('老版本（1.3.4）被清掉', oldExit.exited, `${oldExit.elapsed}ms`)
  check('日志记了「发现另一个工作台」', segC.includes('发现另一个工作台'), segC.trim().split('\n').slice(-4).join(' | '))
  check('主人实例仍然活着', !hostExited, `pid=${hostPid}`)
  check('最后只剩一个工作台进程', procs().length === 1, `n=${procs().length}`)

  for (const p of procs()) kill(p.pid)
  await sleep(1200)
}

// ---------------------------------------------------------------- 收尾
for (const p of procs()) {
  if (before.some((b) => b.pid === p.pid)) continue
  kill(p.pid)
}
try {
  fs.rmSync(work, { recursive: true, force: true })
} catch {}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${failed.length === 0 ? '跨版本单实例验收通过' : failed.length + ' 项失败'}`)
process.exit(failed.length === 0 ? 0 : 1)
