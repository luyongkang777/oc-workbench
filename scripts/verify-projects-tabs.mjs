// 界面层验收：起真机 exe，数项目标签是不是两条。
// 用法：node scripts/verify-projects-tabs.mjs
// 前置：没有别的 oc-workbench 在跑；先 node scripts/build-exe.mjs。
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EXE = process.argv[2] ?? 'shell/target/release/oc-workbench-shell.exe'
const PORT = 9231
const DATA_DIR = path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'oc-workbench')
const PROJECTS = path.join(DATA_DIR, 'projects.json')
const BACKUP = `${PROJECTS}.tabs-backup`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function listWorkbench() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq oc-workbench*', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
    })
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('"'))
  } catch {
    return []
  }
}

if (listWorkbench().length > 0) {
  console.error('还有工作台在跑，先关掉再验收。')
  process.exit(2)
}

const sample = [
  { path: 'F:\\opencode\\workbench', name: 'workbench', lastUsed: Date.now(), state: { file: null, view: 'code' } },
  { path: 'F:\\硬件开发', name: '硬件开发', lastUsed: Date.now() - 1000, state: { file: null, view: 'code' } },
]
if (fs.existsSync(PROJECTS)) fs.copyFileSync(PROJECTS, BACKUP)
fs.writeFileSync(PROJECTS, JSON.stringify(sample))

const child = spawn(EXE, [], {
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
})
child.unref()
await sleep(9000)

let failed = false
try {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('没找到页面目标')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  const names = await send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('.project-tab-name')].map((e) => e.textContent)`,
    returnByValue: true,
  })
  const list = names.result.value ?? []
  failed = list.length !== 2 || !list.includes('workbench') || !list.includes('硬件开发')
  console.log(`${failed ? 'FAIL' : 'PASS'} 界面标签 ${list.length} 个：${list.join(', ')}`)
  ws.close()
} catch (err) {
  failed = true
  console.error(`FAIL ${err.message}`)
} finally {
  for (const line of listWorkbench()) {
    const pid = line.replace(/"/g, '').split(',')[1]
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', pid], { stdio: 'ignore' })
    } catch {
      /* 已退出 */
    }
  }
  if (fs.existsSync(BACKUP)) {
    fs.copyFileSync(BACKUP, PROJECTS)
    fs.unlinkSync(BACKUP)
  }
}

console.log(failed ? '结论：FAIL' : '结论：PASS')
process.exit(failed ? 1 : 0)
