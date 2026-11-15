// 手机/平板多分辨率压力测试：所有设备尺寸一次过，
// 断言「无横向溢出 / 单列与三栏符合预期 / 底部导航 / 底部占比 / 触摸目标」。
// 用法：node scripts/stress-mobile.mjs [cdpPort]
// 前置：vite dev 在 5273；或 exe 带 CDP 时用 OCW_TARGET=exe
const port = Number(process.argv[2] || 9231)
const ROOT = process.argv[3] || 'F:\\opencode\\workbench'
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
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '脚本执行失败')
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 设备矩阵：CSS 逻辑像素宽高（竖屏），横屏单独列
const DEVICES = [
  ['Android', 'Galaxy Fold 外屏', 280, 653],
  ['Android', '老安卓小屏', 320, 480],
  ['Android', '320x568', 320, 568],
  ['Android', '主流 360x640', 360, 640],
  ['Android', '360x780', 360, 780],
  ['Android', 'Pixel 4a', 393, 851],
  ['Android', 'Pixel 7 Pro', 412, 915],
  ['Android', '大屏 432x960', 432, 960],
  ['Android', '折叠展开', 601, 962],
  ['Android', '平板 800x1280', 800, 1280],
  ['iOS', 'iPhone SE1', 320, 568],
  ['iOS', 'iPhone 8', 375, 667],
  ['iOS', 'iPhone 13 mini', 375, 812],
  ['iOS', 'iPhone 14', 390, 844],
  ['iOS', 'iPhone 15', 393, 852],
  ['iOS', 'iPhone 15 Pro Max', 430, 932],
  ['iOS', 'iPhone 16 Pro Max', 440, 956],
  ['iOS', 'iPad mini', 768, 1024],
  ['iOS', 'iPad Air', 820, 1180],
  ['iOS', 'iPad Pro 11', 834, 1194],
  ['iOS', 'iPad Pro 12.9', 1024, 1366],
  ['横屏', 'iPhone SE1 横', 568, 320],
  ['横屏', 'iPhone 8 横', 667, 375],
  ['横屏', 'iPhone 13 mini 横', 812, 375],
  ['横屏', 'iPhone 14 横', 844, 390],
  ['横屏', 'iPhone 15 横', 852, 393],
  ['横屏', 'iPhone 15 Pro Max 横', 932, 430],
  ['横屏', 'iPhone 16 Pro Max 横', 956, 440],
  ['横屏', 'Android 平板 横', 1280, 800],
  ['平板横', 'iPad mini 横', 1024, 768],
  ['平板横', 'iPad Air 横', 1180, 820],
  ['桌面', '窄窗刚好单列', 700, 900],
  ['桌面', '单列/三栏边界 801', 801, 900],
  ['桌面', '窄窗三栏', 900, 700],
  ['桌面', '1280x800', 1280, 800],
  ['桌面', '1920x1080', 1920, 1080],
]

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: false })
if (DEV_URL) {
  await send('Page.navigate', { url: DEV_URL })
  await sleep(2500)
} else {
  await send('Page.reload')
  await sleep(4000)
}
await evaluate(`localStorage.setItem('oc-workbench:root', ${JSON.stringify(ROOT)}); localStorage.setItem('oc-workbench:mobile-pane','chat'); true`)
await send('Page.reload')
await sleep(6000)

// 切到聊天栏，保证输入区参与占位计算
const clickChat = () =>
  evaluate(`(() => {
    const btn = [...document.querySelectorAll('.mobile-nav-btn')].find((b) => b.textContent.includes('聊天'))
    if (!btn) return false
    if (!btn.classList.contains('active')) btn.click()
    return true
  })()`)

const MAX_WIDTH = 800
const MAX_HEIGHT = 520
const expectMobile = (w, h) => w <= MAX_WIDTH || h <= MAX_HEIGHT

const results = []
async function probe(device) {
  const [group, name, w, h] = device
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false })
  await sleep(320)
  await clickChat()
  await sleep(180)

  const v = await evaluate(`(() => {
    const de = document.documentElement
    const panes = ['.sidebar', '.editor-pane', '.chat-pane'].map((sel) => {
      const el = document.querySelector(sel)
      if (!el) return false
      return getComputedStyle(el).display !== 'none'
    })
    const nav = document.querySelector('.mobile-nav')
    const headerScroll = (() => {
      const el = document.querySelector('.chat-header')
      return el ? { cw: el.clientWidth, sw: el.scrollWidth } : null
    })()
    const bottom = (() => {
      const sels = ['.chat-input-wrap', '.chat-stats', '[data-composer-stat="mcp"]', '.subagent-bar', '.terminal', '.mobile-nav']
      let total = 0
      for (const s of sels) { const el = document.querySelector(s); if (el) total += el.getBoundingClientRect().height }
      return Math.round(total)
    })()
    const input = document.querySelector('.chat-input')
    const inputRect = input ? input.getBoundingClientRect() : null
    const smallBtns = [...document.querySelectorAll('.mobile-nav-btn, .chat-send, .chat-attach-add, .pane-action, .review-toggle, .topbar-iconbtn')]
      .map((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })
      .filter((b) => b.w > 0 && b.h > 0 && (b.w < 32 || b.h < 32))
    return {
      cw: de.clientWidth,
      docW: de.scrollWidth,
      mobile: document.querySelector('.app')?.dataset.mobile === '1',
      navH: nav ? Math.round(nav.getBoundingClientRect().height) : 0,
      panes,
      headerScroll,
      bottom,
      vh: innerHeight,
      inputVisible: !!inputRect && inputRect.width > 0 && inputRect.height > 0,
      inputH: inputRect ? Math.round(inputRect.height) : 0,
      smallBtns: smallBtns.length,
    }
  })()`)

  const problems = []
  const mobileExpected = expectMobile(w, h)

  if (v.docW > v.cw + 1) problems.push(`横向溢出 ${v.docW - v.cw}px`)
  if (v.mobile !== mobileExpected) problems.push(`单列状态错误 mobile=${v.mobile} 期望=${mobileExpected}`)

  if (mobileExpected) {
    if (v.navH < 44) problems.push(`底部导航高度 ${v.navH}`)
    const visible = v.panes.filter(Boolean).length
    if (visible !== 1) problems.push(`可见面板 ${visible} 个`)
    if (!v.inputVisible) problems.push('聊天输入框不可见')
    const ratio = v.bottom / v.vh
    if (ratio > 0.32) problems.push(`底部占 ${Math.round(ratio * 100)}%`)
    if (v.smallBtns > 0) problems.push(`${v.smallBtns} 个按钮 <32px`)
  } else {
    if (v.navH !== 0) problems.push('桌面模式仍有底部导航')
    const visible = v.panes.filter(Boolean).length
    if (visible !== 3) problems.push(`桌面可见面板 ${visible} 个`)
  }
  if (v.headerScroll && v.headerScroll.sw > v.headerScroll.cw * 1.25) {
    problems.push(`聊天头部需横滑 ${v.headerScroll.sw - v.headerScroll.cw}px`)
  }

  results.push({ group, name, w, h, problems, bottom: v.bottom, vh: v.vh, headerScroll: v.headerScroll })
  const tag = problems.length === 0 ? 'PASS' : 'FAIL'
  console.log(
    `${tag}  ${String(w).padStart(4)}x${String(h).padEnd(4)}  ${group.padEnd(6)} ${name}` +
      (problems.length ? `  ← ${problems.join('；')}` : ''),
  )
}

for (const device of DEVICES) {
  await probe(device)
}

// ---------- 真机模式：mobile:true + 真机 UA ----------
const REAL = [
  ['iPhone 14 Safari', 390, 844, 3, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'],
  ['Pixel 7 Chrome', 412, 915, 2.625, 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'],
  ['iPad Safari', 820, 1180, 2, 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'],
  ['iPhone SE1 老机', 320, 568, 2, 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1'],
]

console.log('\n--- 真机模式（mobile:true + UA + DPR）---')
for (const [name, w, h, dpr, ua] of REAL) {
  await send('Emulation.setUserAgentOverride', { userAgent: ua })
  await send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: dpr,
    mobile: true,
    screenWidth: w,
    screenHeight: h,
  })
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await sleep(800)
  const v = await evaluate(`(() => {
    const de = document.documentElement
    return {
      cw: de.clientWidth,
      docW: de.scrollWidth,
      mobile: document.querySelector('.app')?.dataset.mobile === '1',
      nav: !!document.querySelector('.mobile-nav'),
      navH: (() => { const el = document.querySelector('.mobile-nav'); return el ? Math.round(el.getBoundingClientRect().height) : 0 })(),
      vv: visualViewport ? Math.round(visualViewport.width) : 0,
      scale: visualViewport ? Number(visualViewport.scale.toFixed(2)) : 0,
      dpr: devicePixelRatio,
    }
  })()`)
  const problems = []
  if (v.docW > v.cw + 1) problems.push(`横向溢出 ${v.docW - v.cw}px`)
  if (v.mobile !== expectMobile(w, h)) problems.push(`单列状态错误 mobile=${v.mobile} 期望=${expectMobile(w, h)}`)
  if (expectMobile(w, h) && v.navH < 44) problems.push(`导航 ${v.navH}`)
  if (v.scale !== 1) problems.push(`页面被缩放 ${v.scale}`)
  results.push({ group: '真机', name, w, h, problems })
  console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'}  ${w}x${h}  ${name}  (dpr=${v.dpr} vv=${v.vv} docW=${v.docW})` + (problems.length ? `  ← ${problems.join('；')}` : ''))
}

await send('Emulation.setUserAgentOverride', { userAgent: '' })
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: false })

const failed = results.filter((r) => r.problems.length > 0)
console.log(`\n合计 ${results.length} 档设备，失败 ${failed.length} 档`)
if (failed.length) {
  console.log('\n失败清单：')
  for (const f of failed) console.log(` - ${f.w}x${f.h} ${f.name}: ${f.problems.join('；')}`)
}
process.exit(failed.length === 0 ? 0 : 1)
