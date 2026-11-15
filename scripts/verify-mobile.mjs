// 手机布局验收：窄视口单列 + 底部导航 + 无横向溢出。
// 用法：node scripts/verify-mobile.mjs [cdpPort]
// 前置：vite dev 在 5273（或 exe 已用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9231 启动）
const port = Number(process.argv[2] || 9231)
const ROOT = process.argv[3] || 'F:\\opencode\\workbench'
// 给 OCW_URL 才导航（测 dev）；不给我就直接测当前页面（exe 里嵌的 dist）
const DEV_URL = process.env.OCW_URL ?? (process.env.OCW_TARGET === 'exe' ? '' : 'http://127.0.0.1:5273/')

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('没找到页面目标')

const ws = new WebSocket(page.webSocketDebuggerUrl)
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
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || '脚本执行失败')
  return result.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync('.tmp', { recursive: true })
  writeFileSync(`.tmp/${name}.png`, Buffer.from(r.data, 'base64'))
}

const report = []
function check(name, ok, detail = '') {
  report.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
}

// 首次打开：先给 root，再 reload（新 profile 是选目录欢迎页）
await send('Page.enable')
await setViewport(390, 844)
if (DEV_URL) {
  await send('Page.navigate', { url: DEV_URL })
  await sleep(2500)
}
await evaluate(`localStorage.setItem('oc-workbench:root', ${JSON.stringify(ROOT)}); true`)
await send('Page.reload')
await sleep(6000)

// ---------- 1. 各宽度下都不能横向溢出 ----------
for (const [w, h] of [
  [320, 640],
  [360, 780],
  [390, 844],
  [414, 896],
  [768, 1024],
  [1024, 768],
]) {
  await setViewport(w, h)
  await sleep(500)
  const box = await evaluate(`({
    innerW: innerWidth,
    docW: document.documentElement.scrollWidth,
    mobile: document.querySelector('.app')?.dataset.mobile === '1',
    nav: (() => { const el = document.querySelector('.mobile-nav'); if (!el) return 0; return Math.round(el.getBoundingClientRect().height) })(),
  })`)
  check(`${w}x${h} 无横向溢出`, box.docW <= box.innerW + 1, `docW=${box.docW} innerW=${box.innerW}`)
  if (w <= 800) {
    check(`${w}x${h} 单列模式 + 底部导航`, box.mobile && box.nav >= 44, `mobile=${box.mobile} nav=${box.nav}`)
  } else {
    check(`${w}x${h} 保持桌面三栏`, !box.mobile && box.nav === 0)
  }
}

// ---------- 2. 390 宽下三栏切换 ----------
await setViewport(390, 844)
await sleep(600)

const visible = async () =>
  evaluate(`({
    files: getComputedStyle(document.querySelector('.sidebar')).display !== 'none',
    editor: getComputedStyle(document.querySelector('.editor-pane')).display !== 'none',
    chat: getComputedStyle(document.querySelector('.chat-pane')).display !== 'none',
  })`)

const clickNav = async (label) =>
  evaluate(`(() => {
    const btn = [...document.querySelectorAll('.mobile-nav-btn')].find((b) => b.textContent.includes(${JSON.stringify(label)}))
    if (!btn) return false
    btn.click()
    return true
  })()`)

check('底部导航有三个按钮', (await evaluate(`document.querySelectorAll('.mobile-nav-btn').length`)) === 3)

await clickNav('文件')
await sleep(300)
let v = await visible()
check('切到文件：只显示文件树', v.files && !v.editor && !v.chat, JSON.stringify(v))
await shot('mobile-pane-files')

// 文件树行高：手机上应是 40（虚拟列表与 CSS 同步）
const rowH = await evaluate(`(() => {
  const row = document.querySelector('.tree-row')
  return row ? Math.round(row.getBoundingClientRect().height) : 0
})()`)
check('文件树行高放大到 40', rowH === 40, `实测 ${rowH}`)

await clickNav('编辑')
await sleep(300)
v = await visible()
check('切到编辑：只显示编辑器', v.editor && !v.files && !v.chat, JSON.stringify(v))
await shot('mobile-pane-editor')

await clickNav('聊天')
await sleep(300)
v = await visible()
check('切到聊天：只显示聊天', v.chat && !v.files && !v.editor, JSON.stringify(v))
await shot('mobile-pane-chat')

// ---------- 3. 点开文件后自动跳到编辑器 ----------
await clickNav('文件')
await sleep(400)
const opened = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.tree-row')].filter((r) => r.title && !r.title.endsWith('\\\\'))
  const fileRow = rows.find((r) => /\\.(tsx?|json|md|css)$/.test(r.title))
  if (!fileRow) return { ok: false, reason: '树里没有可点的文件行' }
  fileRow.click()
  return { ok: true, title: fileRow.title }
})()`)
await sleep(1500)
const afterOpen = await evaluate(`({
  pane: document.querySelector('.main')?.dataset.pane,
  editor: getComputedStyle(document.querySelector('.editor-pane')).display !== 'none',
  tabs: document.querySelectorAll('.file-tab').length,
})`)
check('点开文件后自动切到编辑器', opened.ok && afterOpen.pane === 'editor' && afterOpen.editor, `${opened.title || opened.reason} -> ${JSON.stringify(afterOpen)}`)
await shot('mobile-file-opened')

// ---------- 4. 横屏 + 审查面板 ----------
await setViewport(844, 390)
await sleep(600)
const landscape = await evaluate(`({
  innerW: innerWidth,
  docW: document.documentElement.scrollWidth,
  nav: !!document.querySelector('.mobile-nav'),
})`)
check('横屏 844x390 无横向溢出', landscape.docW <= landscape.innerW + 1, `docW=${landscape.docW}`)
check('横屏仍是单列（不在平板竖屏断点外）', landscape.nav)

await setViewport(390, 844)
await sleep(500)
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.review-toggle')].find((b) => b.textContent.includes('审查'))
  if (btn) btn.click()
  return !!btn
})()`)
await sleep(1200)
const review = await evaluate(`({
  docW: document.documentElement.scrollWidth,
  innerW: innerWidth,
  panel: !!document.querySelector('.review-panel, .diff-panel'),
})`)
check('审查面板在手机上不溢出', review.docW <= review.innerW + 1, `docW=${review.docW} panel=${review.panel}`)
await shot('mobile-review')
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.review-toggle')].find((b) => b.textContent.includes('审查'))
  if (btn) btn.click()
  return true
})()`)
await sleep(500)

// ---------- 5. 触摸目标 ----------
const small = await evaluate(`(() => {
  const sel = '.mobile-nav-btn, .chat-send, .chat-attach-add, .pane-action, .review-toggle, .topbar-iconbtn'
  return [...document.querySelectorAll(sel)]
    .map((el) => { const r = el.getBoundingClientRect(); return { cls: String(el.className).slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) } })
    .filter((b) => b.w > 0 && b.h > 0 && (b.h < 32 || b.w < 32))
})()`)
check('可见按钮不小于 32px', small.length === 0, small.length ? JSON.stringify(small.slice(0, 5)) : '')

// ---------- 5.5 底部控件不占太多屏幕 ----------
await clickNav('聊天')
await sleep(500)
const chrome = await evaluate(`(() => {
  const sels = ['.chat-input-wrap', '.chat-stats', '[data-composer-stat="mcp"]', '.subagent-bar', '.terminal', '.mobile-nav']
  let total = 0
  for (const s of sels) {
    const el = document.querySelector(s)
    if (el) total += el.getBoundingClientRect().height
  }
  return { total: Math.round(total), vh: innerHeight }
})()`)
check('底部控件总高 ≤ 屏高 32%', chrome.total <= chrome.vh * 0.32, `${chrome.total}/${chrome.vh}px`)

// ---------- 6. 输入框 16px 防自动放大 ----------
const inputFont = await evaluate(`(() => {
  const el = document.querySelector('.chat-input')
  return el ? getComputedStyle(el).fontSize : '0px'
})()`)
check('聊天输入框字号 >= 16px', parseFloat(inputFont) >= 16, inputFont)

// ---------- 7. 桌面模式回归：768 以上三栏并排且可拖 ----------
await setViewport(1280, 800)
await sleep(600)
const desk = await evaluate(`({
  mobile: document.querySelector('.app')?.dataset.mobile === '1',
  nav: !!document.querySelector('.mobile-nav'),
  side: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
  chat: Math.round(document.querySelector('.chat-pane').getBoundingClientRect().width),
  resizers: document.querySelectorAll('.col-resizer').length,
  docW: document.documentElement.scrollWidth,
  innerW: innerWidth,
})`)
check('桌面：三栏复原', !desk.mobile && !desk.nav && desk.side === 240 && desk.chat === 520 && desk.resizers === 2, JSON.stringify(desk))
check('桌面：无横向溢出', desk.docW <= desk.innerW + 1, `docW=${desk.docW} innerW=${desk.innerW}`)
await send('Emulation.clearDeviceMetricsOverride')
await shot('desktop-regression')

const failed = report.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}  合计 ${report.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length === 0 ? 0 : 1)
