// 真机验收单实例。两种机器状态都能判：
//   A. 本机已经开着工作台（用户自己的客户端）→ 新启动必须立刻退出并切前台；
//   B. 本机没开 → 第一个留下，第二个必须自己退出。
// 只用 tasklist（纯 ASCII），不碰 PowerShell 的引号。
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const exe = 'F:/opencode/workbench/shell/target/release/oc-workbench-shell.exe'
const logPath = path.join(process.env.LOCALAPPDATA || '', 'oc-workbench', 'gui-error.log')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 名字以 oc-workbench 开头的进程（含用户自己的 oc-workbench.exe） */
function wbPids() {
  const out = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const pids = new Set()
  for (const line of out.split(/\r?\n/)) {
    const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ''))
    if (cols.length < 2) continue
    if (!/^oc-workbench/i.test(cols[0])) continue
    const pid = Number(cols[1])
    if (Number.isFinite(pid)) pids.add(pid)
  }
  return pids
}

function readLog() {
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
}

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const before = wbPids()
const beforePids = [...before]
const logStart = readLog().length
console.log(`开始前已有 oc-workbench* 进程：${beforePids.length ? beforePids.join(',') : '无'}`)

const started = Date.now()
const child = spawn(exe, [], { stdio: 'ignore' })
const childPid = child.pid
let exited = false
child.on('exit', () => {
  exited = true
})

// 最多等 10 秒看它到底留下还是退出
for (let i = 0; i < 40; i += 1) {
  if (exited) break
  await sleep(250)
}
const elapsed = Date.now() - started
const segment = readLog().slice(logStart)
const now = wbPids()

if (exited) {
  // 场景 A：机器上已经开着工作台
  check('已有实例时，新启动自己退出', true, `${elapsed}ms`)
  check('退出得够快（不是等满 4 秒超时）', elapsed < 6000, `${elapsed}ms`)
  check('日志记了「已有实例在运行」', segment.includes('已有实例在运行'))
  check('日志显示把旧窗口切到了前台', segment.includes('切到前台：true'))
  check('没有多出进程', now.size === before.size, `now=${[...now].join(',') || '0'}`)
  check('没动用户的客户端', beforePids.every((pid) => now.has(pid)))
} else {
  // 场景 B：我们是第一个
  check('第一个实例成功启动（拿到单实例凭证）', segment.includes('单实例凭证已获取'))
  await sleep(2500)
  const second = spawn(exe, [], { stdio: 'ignore' })
  let secondExited = false
  second.on('exit', () => {
    secondExited = true
  })
  const t2 = Date.now()
  for (let i = 0; i < 40; i += 1) {
    if (secondExited) break
    await sleep(250)
  }
  const e2 = Date.now() - t2
  const now2 = wbPids()
  check('第二个实例自己退出', secondExited, `${e2}ms`)
  check('进程数只多了第一个', now2.size === before.size + 1, `now=${[...now2].join(',')}`)
  check('第一个实例还活着', now2.has(childPid ?? -1), `first=${childPid}`)
  // 收尾：只杀我们自己起的
  try {
    execFileSync('taskkill.exe', ['/PID', String(childPid), '/T', '/F'], { encoding: 'utf8' })
  } catch {}
  await sleep(1200)
  const after = wbPids()
  check('收尾只关掉自己起的实例', after.size === before.size, `after=${[...after].join(',') || '0'}`)
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${failed.length === 0 ? '单实例验收通过' : failed.length + ' 项失败'}`)
console.log('日志片段:\n' + (segment.trim() || '(空)'))
process.exit(failed.length === 0 ? 0 : 1)
