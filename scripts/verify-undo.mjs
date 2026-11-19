// 「回到上一版」真机验收：
//  1) 按钮在输入框旁可见、无历史时禁用
//  2) 真发一轮让模型改文件 → 文件真的变了
//  3) 点「回到上一版」→ 文件当场还原、消息被截断、提示条出现
//  4) 点「取消回撤」→ 文件退回改动后状态（可反悔）
// 用法：node scripts/verify-undo.mjs [port]
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.argv[2] ?? '9233'
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = path.resolve('.tmp/undo-project')
const TARGET = path.join(ROOT, 'app.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/json/list`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(1000)
  }
  throw new Error('连不上 CDP')
}

function rpc(ws) {
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    const slot = pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    if (msg.error) slot.reject(new Error(JSON.stringify(msg.error)))
    else slot.resolve(msg.result)
  })
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
}

async function evaluate(send, expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? 'evaluate 抛错')
  }
  return res.result.value
}

const readTarget = () => fs.readFileSync(TARGET, 'utf8')

/** 用原生 setter 写 textarea 并派发 input，React 受控组件才认 */
function typeInto(selector, text) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`
}

async function main() {
  // 1. 干净小项目（目录被前一轮的会话当工作目录占着时删不掉，只重建内容）
  fs.mkdirSync(ROOT, { recursive: true })
  fs.rmSync(path.join(ROOT, '.git'), { recursive: true, force: true })
  fs.writeFileSync(TARGET, 'const version = 1\n')
  execFileSync('git', ['init', '-q'], { cwd: ROOT })
  execFileSync('git', ['add', '-A'], { cwd: ROOT })
  execFileSync(
    'git',
    ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init'],
    { cwd: ROOT },
  )

  // 2. Edge（独立 profile）
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  const profile = path.resolve('.tmp/edge-undo')
  fs.rmSync(profile, { recursive: true, force: true })
  const child = spawn(
    edge,
    [
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1440,900',
      'http://127.0.0.1:5273/',
    ],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()

  const ws = new WebSocket(await connect())
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  const send = rpc(ws)
  await send('Runtime.enable')
  await send('Page.enable')

  // 3. 指定项目目录后重载（新 profile 没有最近项目）
  await evaluate(send, `localStorage.setItem('oc-workbench:root', ${JSON.stringify(ROOT)}); true`)
  await send('Page.reload')
  await sleep(6000)

  let ready = false
  for (let i = 0; i < 40; i++) {
    ready = await evaluate(send, `Boolean(document.querySelector('.chat-input'))`)
    if (ready) break
    await sleep(1000)
  }
  check('输入框出现（项目已加载）', ready)
  if (!ready) return finish()

  // 4. 按钮可见性
  const btn = await evaluate(
    send,
    `(() => {
      const b = document.querySelector('.chat-undo')
      if (!b) return null
      const r = b.getBoundingClientRect()
      // 按钮现在收在输入框内的工具条里，不是 .chat-input-row 的直接子元素
      const row = b.closest('.chat-input-row')?.getBoundingClientRect()
      return {
        text: b.textContent.trim(),
        w: Math.round(r.width), h: Math.round(r.height),
        inRow: Boolean(b.closest('.chat-input-row')),
        rowH: row ? Math.round(row.height) : 0,
        disabled: b.disabled,
        title: b.title,
      }
    })()`,
  )
  check('「回到上一版」按钮存在', Boolean(btn), btn ? `文字=${btn.text}` : '找不到 .chat-undo')
  check('按钮在输入行里、有实际尺寸', Boolean(btn && btn.inRow && btn.w > 0 && btn.h > 0),
    btn ? `${btn.w}x${btn.h} inRow=${btn.inRow}` : '')
  check('没有可撤回的一轮时禁用', Boolean(btn && btn.disabled), btn ? `disabled=${btn.disabled}` : '')

  // 5. 真发一轮，让模型改文件
  const typed = await evaluate(send, typeInto('.chat-input', '把 app.js 里的 version 改成 2，只改这一个文件，改完立刻结束。'))
  check('能把指令打进输入框', typed)
  await evaluate(send, `(() => { const b = [...document.querySelectorAll('.chat-send')].find(x => x.textContent.trim() === '发送'); b?.click(); return Boolean(b) })()`)

  let changed = false
  for (let i = 0; i < 60; i++) {
    await sleep(2000)
    if (/version\s*=\s*2/.test(readTarget())) { changed = true; break }
  }
  check('模型真的把文件改了（version = 2）', changed, changed ? '' : readTarget().trim())

  // 等这一轮结束（发送按钮回到「发送」且回撤按钮可用）
  let enabled = false
  for (let i = 0; i < 60; i++) {
    await sleep(2000)
    enabled = await evaluate(send, `(() => { const b = document.querySelector('.chat-undo'); return Boolean(b && !b.disabled) })()`)
    if (enabled) break
  }
  check('一轮结束后「回到上一版」变为可用', enabled)

  // 6. 点「回到上一版」
  const before = await evaluate(send, `document.querySelectorAll('.chat-turn').length`)
  await evaluate(send, `document.querySelector('.chat-undo').click(); true`)

  let restored = false
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    if (/version\s*=\s*1/.test(readTarget())) { restored = true; break }
  }
  check('点一下就把磁盘文件还原成上一版（version = 1）', restored, restored ? '' : readTarget().trim())

  const after = await evaluate(send, `document.querySelectorAll('.chat-turn').length`)
  check('对话里那一轮被隐藏了', after < before, `${before} → ${after}`)

  const notice = await evaluate(
    send,
    `(() => { const n = document.querySelector('.chat-notice'); return n ? n.textContent.trim() : '' })()`,
  )
  check('出现回撤提示条', /回撤/.test(notice), notice)

  const cancelBtn = await evaluate(
    send,
    `(() => { const b = document.querySelector('.chat-notice-action'); return b ? b.textContent.trim() : '' })()`,
  )
  check('提示条带「取消回撤」入口', cancelBtn === '取消回撤', cancelBtn)

  // 7. 取消回撤 → 文件退回改动后状态
  await evaluate(send, `document.querySelector('.chat-notice-action')?.click(); true`)
  let revertedBack = false
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    if (/version\s*=\s*2/.test(readTarget())) { revertedBack = true; break }
  }
  check('取消回撤后文件退回改动后状态（可反悔）', revertedBack, revertedBack ? '' : readTarget().trim())

  const afterCancel = await evaluate(send, `document.querySelectorAll('.chat-turn').length`)
  check('取消回撤后消息重新显示', afterCancel === before, `${before} → ${afterCancel}`)

  finish()

  function finish() {
    const failed = results.filter((r) => !r.ok)
    fs.writeFileSync(
      path.resolve('.tmp/verify-undo.json'),
      JSON.stringify({ results, at: new Date().toISOString() }, null, 2),
    )
    console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`)
    process.exit(failed.length === 0 ? 0 : 1)
  }
}

main().catch((err) => {
  console.error('验收脚本异常：', err.message)
  process.exit(1)
})
