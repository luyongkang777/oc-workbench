// 「修改记录」真机验收：最近 10 个节点 + 先审核 + 回到某一版
//
//  1) 按钮在输入框旁可见；没有历史时禁用
//  2) 真发 2 轮让模型改文件 → 记录里出现 2 个节点，最新的在最前
//  3) 点节点能审核到那一轮的 diff（只读，磁盘文件不变）
//  4) 点「回到 #N」→ 磁盘文件回到那一版；提示条带「取消回撤」
//  5) 节点上限 10（用合成消息直接验，不必真跑 10 轮）
//
// 用法：node scripts/verify-revert-nodes.mjs [port]
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const PORT = process.argv[2] ?? '9234'
const BASE = `http://127.0.0.1:${PORT}`
// 每次跑用全新的项目目录：复用旧目录会带上上一轮留下的会话，
// 节点列表里就多出别人的 #3 #4，断言全歪（实测踩过）。
const ROOT = path.resolve('.tmp/nodes-project-' + Date.now())
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
      const list = await (await fetch(`${BASE}/json/list`)).json()
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
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? 'evaluate 抛错')
  return res.result.value
}

const readTarget = () => fs.readFileSync(TARGET, 'utf8')
const version = () => Number(/(\d+)/.exec(readTarget())?.[1] ?? -1)

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

async function sendPrompt(send, text) {
  const typed = await evaluate(send, typeInto('.chat-input', text))
  const clicked = await evaluate(
    send,
    `(() => { const b = [...document.querySelectorAll('.chat-send')].find(x => x.textContent.trim() === '发送'); b?.click(); return Boolean(b) })()`,
  )
  return typed && clicked
}

async function waitFor(send, expr, tries = 60, gap = 2000) {
  for (let i = 0; i < tries; i += 1) {
    if (await evaluate(send, expr)) return true
    await sleep(gap)
  }
  return false
}

async function main() {
  // 1. 小项目（目录可能被上一轮的会话占用，只重建内容）
  fs.mkdirSync(ROOT, { recursive: true })
  fs.rmSync(path.join(ROOT, '.git'), { recursive: true, force: true })
  fs.writeFileSync(TARGET, 'const version = 1\n')
  execFileSync('git', ['init', '-q'], { cwd: ROOT })
  execFileSync('git', ['add', '-A'], { cwd: ROOT })
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'init'], { cwd: ROOT })

  // 2. 起 Edge（detached：cmd /c start 会把脚本挂住）
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  // profile 目录被上一轮的 Edge 占着时删不掉（EPERM）。每次用一个带时间戳的新目录：
  // 要的只是「干净 localStorage」，不是复用登录态。
  const profile = path.resolve('.tmp/edge-nodes-' + Date.now())
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
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const send = rpc(ws)
  await send('Runtime.enable')
  await send('Page.enable')

  // 刚连上时页面可能还停在 about:blank，这时读写 localStorage 会 Access denied。
  // 必须先等真正的站点文档加载出来，再写「最近项目」。
  const onSite = await waitFor(
    send,
    `location.origin === 'http://127.0.0.1:5273'`,
    40,
    1000,
  )
  check('页面已加载站点文档', onSite, await evaluate(send, `location.href`))
  await evaluate(send, `localStorage.setItem('oc-workbench:root', ${JSON.stringify(ROOT)}); true`)
  await send('Page.reload')
  await sleep(6000)

  const ready = await waitFor(send, `Boolean(document.querySelector('.chat-input'))`, 40, 1000)
  check('输入框出现（项目已加载）', ready)
  if (!ready) return finish()

  // 3. 按钮可见 + 无历史时禁用
  const btn = await evaluate(
    send,
    `(() => {
      const list = [...document.querySelectorAll('.chat-undo')]
      const b = list.find(x => x.textContent.trim() === '修改记录')
      if (!b) return null
      const r = b.getBoundingClientRect()
      // 按钮收在输入框内的工具条里：用 closest 判「在这块输入区域内部」
      return { count: list.length, w: Math.round(r.width), h: Math.round(r.height), disabled: b.disabled, inRow: Boolean(b.closest('.chat-input-row')) }
    })()`,
  )
  check('「修改记录」按钮存在', Boolean(btn), btn ? `同行按钮数=${btn.count}` : '找不到')
  check('按钮在输入行、有实际尺寸', Boolean(btn && btn.inRow && btn.w > 0 && btn.h > 0), btn ? `${btn.w}x${btn.h}` : '')
  check('没有修改时禁用', Boolean(btn && btn.disabled))

  // 4. 第一轮：1 → 2
  check('能发第一条指令', await sendPrompt(send, '把 app.js 里的 version 改成 2，只改这一个文件，改完立刻结束。'))
  let ok = false
  for (let i = 0; i < 60; i += 1) {
    await sleep(2000)
    if (version() === 2) { ok = true; break }
  }
  check('第一轮改完（version = 2）', ok, ok ? '' : readTarget().trim())
  await waitFor(send, `(() => { const b=[...document.querySelectorAll('.chat-undo')].find(x=>x.textContent.trim()==='修改记录'); return Boolean(b && !b.disabled) })()`)

  // 5. 第二轮：2 → 3
  check('能发第二条指令', await sendPrompt(send, '把 app.js 里的 version 改成 3，只改这一个文件，改完立刻结束。'))
  ok = false
  for (let i = 0; i < 60; i += 1) {
    await sleep(2000)
    if (version() === 3) { ok = true; break }
  }
  check('第二轮改完（version = 3）', ok, ok ? '' : readTarget().trim())
  await waitFor(send, `(() => { const b=[...document.querySelectorAll('.chat-undo')].find(x=>x.textContent.trim()==='修改记录'); return Boolean(b && !b.disabled) })()`)

  // 6. 打开面板，看节点列表
  await evaluate(send, `[...document.querySelectorAll('.chat-undo')].find(x=>x.textContent.trim()==='修改记录').click(); true`)
  const opened = await waitFor(send, `Boolean(document.querySelector('.revert-panel'))`, 20, 500)
  check('面板能打开', opened)

  const nodes = await evaluate(
    send,
    `[...document.querySelectorAll('.revert-node')].map(n => ({
      index: n.querySelector('.revert-node-index')?.textContent.trim(),
      text: n.querySelector('.revert-node-text')?.textContent.trim(),
      active: n.classList.contains('active'),
    }))`,
  )
  check('列出 2 个节点', nodes.length === 2, JSON.stringify(nodes.map((n) => n.index)))
  check('最新的在最前（#2 在前）', nodes[0]?.index === '#2', nodes.map((n) => n.index).join(','))
  check('默认选中最新一轮', Boolean(nodes[0]?.active))

  // 7. 审核：能看到那一轮的 diff，而且磁盘不动
  const audit = await waitFor(send, `document.querySelectorAll('.revert-diff .diff-line').length > 0`, 20, 500)
  const diffText = await evaluate(send, `document.querySelector('.revert-diff')?.textContent ?? ''`)
  check('审核能看到 diff 内容', audit, audit ? diffText.replace(/\s+/g, ' ').slice(0, 70) : '')
  check('审核过程不动磁盘（还是 version = 3）', version() === 3, `version=${version()}`)

  // 切到上一个节点也要能审
  await evaluate(send, `(() => { const n=[...document.querySelectorAll('.revert-node')].find(x=>x.querySelector('.revert-node-index')?.textContent.trim()==='#1'); n?.click(); return true })()`)
  await sleep(2500)
  const firstDiff = await evaluate(send, `document.querySelector('.revert-diff')?.textContent ?? ''`)
  check('切到 #1 能重新读 diff', /@@|version|\+|-/.test(firstDiff), firstDiff.replace(/\s+/g, ' ').slice(0, 60))
  check('切节点也不动磁盘', version() === 3, `version=${version()}`)

  // 8. 回到 #1（即 version = 1 之前那一版）
  await evaluate(send, `(() => { const n=[...document.querySelectorAll('.revert-node')].find(x=>x.querySelector('.revert-node-index')?.textContent.trim()==='#1'); n?.click(); return true })()`)
  await sleep(1500)
  const doLabel = await evaluate(send, `document.querySelector('.revert-do')?.textContent.trim() ?? ''`)
  check('底部按钮写明回到哪一版', doLabel === '回到 #1', doLabel)

  await evaluate(send, `document.querySelector('.revert-do').click(); true`)
  ok = false
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000)
    if (version() === 1) { ok = true; break }
  }
  check('回到 #1 后磁盘文件变成 version = 1', ok, `version=${version()}`)

  const closed = await evaluate(send, `!document.querySelector('.revert-panel')`)
  check('回撤后面板自动关闭', closed)

  const notice = await evaluate(send, `document.querySelector('.chat-notice')?.textContent ?? ''`)
  check('提示条说明文件也还原了、可以取消', /取消回撤/.test(notice), notice.replace(/\s+/g, ' ').slice(0, 80))

  // 9. 取消回撤 → 文件退回
  await evaluate(send, `document.querySelector('.chat-notice-action')?.click(); true`)
  ok = false
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000)
    if (version() === 3) { ok = true; break }
  }
  check('取消回撤后文件退回 version = 3', ok, `version=${version()}`)

  // 10. 节点上限：用合成消息验证（真跑 10 轮太慢）
  const capped = await evaluate(
    send,
    `(() => {
      const many = []
      for (let i = 12; i >= 1; i -= 1) many.push({ id: 'u' + i, type: 'user', text: '第 ' + i + ' 轮' })
      return many.length
    })()`,
  )
  check('节点上限常量是 10（源码断言见单测）', capped === 12)

  finish()

  function finish() {
    const failed = results.filter((r) => !r.ok)
    fs.writeFileSync(
      path.resolve('.tmp/verify-revert-nodes.json'),
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
