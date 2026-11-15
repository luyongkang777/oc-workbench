// 手机端「功能可打开」冒烟：逐个点开下拉/弹层/面板，断言
//   1) 目标出现且可见
//   2) 完全在视口内（不溢出屏幕）
//   3) 里面有可点项
// 用法：node scripts/smoke-mobile-features.mjs [cdpPort]
const port = Number(process.argv[2] || 9231)
const ROOT = process.argv[3] || 'F:\\opencode\\workbench'
const DEV_URL = process.env.OCW_URL ?? (process.env.OCW_TARGET === 'exe' ? '' : 'http://127.0.0.1:5273/')
const SIZES = (process.env.OCW_SIZES || '390x844,320x568,844x390,768x1024')
  .split(',')
  .map((s) => s.split('x').map(Number))

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('没找到页面目标')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
// 网络层错误（nginx 404 / 后端 500）：界面可能只报一小行错，功能断言容易漏
const httpErrors = []
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.method === 'Network.responseReceived') {
    const res = msg.params?.response
    if (!res || res.status < 400) return
    // 两类环境噪音，不算产品失败：
    //  1) exe 直连 127.0.0.1:17800 时没有远程 cookie，/local/* 会 403（本地直连的鉴权行为）；
    //  2) vite dev 的 mock 没实现全部 /local/* （如 /local/cli/status 返回 400），生产由 Rust 处理。
    const localDirect = res.url.includes('127.0.0.1:17800') && res.status === 403
    const devMock = res.url.includes('127.0.0.1:5273/local/')
    if (!localDirect && !devMock) httpErrors.push({ status: res.status, url: res.url.split('?')[0] })
  }
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
const { writeFileSync, mkdirSync } = await import('node:fs')
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  mkdirSync('.tmp/smoke', { recursive: true })
  writeFileSync(`.tmp/smoke/${name}.png`, Buffer.from(r.data, 'base64'))
}

// 点击辅助：按 selector 或文字找元素，返回是否点到（不可见算 skip）
const clickBy = (selector) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return 'missing'
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return 'hidden'
    el.click()
    return 'ok'
  })()`)

const clickByText = (text, selector = '.review-toggle, .project-tab') =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.includes(${JSON.stringify(text)}))
    if (!el) return 'missing'
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return 'hidden'
    el.click()
    return 'ok'
  })()`)

const closeLayers = () =>
  evaluate(`(() => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    document.body.click()
    return true
  })()`)

const clickNav = (label) =>
  evaluate(`(() => {
    const btn = [...document.querySelectorAll('.mobile-nav-btn')].find((b) => b.textContent.includes(${JSON.stringify(label)}))
    if (!btn) return 'missing'
    if (!btn.classList.contains('active')) btn.click()
    return 'ok'
  })()`)

const measure = (selector) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return { found: false }
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const clickable = [...el.querySelectorAll('button, [role="button"], [role="tab"], [role="option"], .mode-item, .model-item, .variant-item, .chat-session-item, .purge-menu-head, .git-row, .review-row')]
      .filter((b) => { const q = b.getBoundingClientRect(); return q.width > 0 && q.height > 0 })
      .length
    return {
      found: true,
      display: cs.display,
      visible: r.width > 1 && r.height > 1 && cs.display !== 'none' && cs.visibility !== 'hidden',
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) },
      clickable,
      pos: cs.position,
      text: (el.textContent || '').trim().slice(0, 40),
    }
  })()`)

await send('Page.enable')
await send('Network.enable')
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

const failures = []
const skips = []

// 入口：selector 或 { text, selector }
const measureEntry = (c) =>
  evaluate(`(() => {
    const c = ${JSON.stringify(c)}
    let el = null
    if (c.entryText) {
      el = [...document.querySelectorAll(c.selector || '*')].find((n) => n.textContent.includes(c.entryText))
    } else {
      el = document.querySelector(c.selector)
    }
    if (!el) return { found: false }
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const visible = r.width > 1 && r.height > 1 && cs.display !== 'none' && cs.visibility !== 'hidden'
    return { found: true, visible }
  })()`)

const clickEntry = (c) =>
  evaluate(`(() => {
    const c = ${JSON.stringify(c)}
    let el = null
    if (c.entryText) {
      el = [...document.querySelectorAll(c.selector || '*')].find((n) => n.textContent.includes(c.entryText))
    } else {
      el = document.querySelector(c.selector)
    }
    if (!el) return 'missing'
    el.click()
    return 'ok'
  })()`)

async function runCase(size, c) {
  const [w, h] = size
  await clickNav('聊天')
  await sleep(150)
  await closeLayers()
  await sleep(120)

  const entry = await measureEntry(c)
  if (!entry.found) {
    skips.push({ size: `${w}x${h}`, name: c.name, why: '入口不存在' })
    console.log(`SKIP  ${w}x${h}  ${c.name}  (入口不存在)`)
    return
  }
  if (!entry.visible) {
    skips.push({ size: `${w}x${h}`, name: c.name, why: '入口在本尺寸隐藏' })
    console.log(`SKIP  ${w}x${h}  ${c.name}  (入口在本尺寸隐藏)`)
    return
  }

  await clickEntry(c)
  await sleep(450)

  const m = await measure(c.layer)
  const problems = []
  if (!m.found) problems.push('弹层没出现')
  else {
    if (!m.visible) problems.push(`弹层不可见 display=${m.display}`)
    if (m.rect.x < -1 || m.rect.y < -1 || m.rect.right > w + 1 || m.rect.bottom > h + 1) {
      problems.push(`超出屏幕 x=${m.rect.x} right=${m.rect.right} bottom=${m.rect.bottom} (屏 ${w}x${h})`)
    }
    if (m.clickable === 0) problems.push('弹层里没有可点项')
  }

  await shot(`${c.id}-${w}x${h}`)

  if (c.close !== false) {
    if (c.close) await c.close()
    else {
      await closeLayers()
      await sleep(200)
      // 这些是「点入口切换」的弹层，兜底再点一次收起来
      if (['.chat-sessions', '.chat-stat-pop', '.purge-menu', '.mode-menu', '.model-menu', '.variant-menu'].includes(c.layer)) {
        await clickEntry(c)
      }
    }
    await sleep(250)
  }

  if (problems.length) {
    failures.push({ size: `${w}x${h}`, name: c.name, problems, m })
    console.log(`FAIL  ${w}x${h}  ${c.name}  ← ${problems.join('；')}`)
  } else {
    console.log(`PASS  ${w}x${h}  ${c.name}  (${m.rect.w}x${m.rect.h}, ${m.clickable} 个可点项)`)
  }
}

const CASES = [
  { id: 'mode', name: '模式下拉（Plan/Build）', selector: '.mode-toggle', layer: '.mode-menu' },
  { id: 'model', name: '模型下拉', selector: '.model-toggle', layer: '.model-menu' },
  { id: 'variant', name: '思考档位下拉', selector: '.variant-toggle', layer: '.variant-menu' },
  { id: 'sessions', name: '会话列表', selector: '.chat-session-toggle', layer: '.chat-sessions' },
  { id: 'stats', name: '统计/MCP 弹层', selector: '.chat-stats [data-composer-stat="activity"]', layer: '.chat-stat-pop' },
  { id: 'purge', name: '破甲菜单', selector: '.purge-caret', layer: '.purge-menu' },
  { id: 'git', name: 'Git 抽屉', entryText: 'Git', selector: '.review-toggle', layer: '.git-panel', close: () => clickByText('Git') },
  { id: 'review', name: '审查面板', entryText: '审查', selector: '.review-toggle', layer: '.review', close: () => clickByText('审查') },
  { id: 'subagent', name: '子智能体面板', selector: '.subagent-bar-btn', layer: '.subagent-pane', close: () => clickBy('.subagent-pane .subagent-head-toggle') },
]

for (const size of SIZES) {
  const [w, h] = size
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false })
  // 每个尺寸都重新加载：展开态、弹层、主题循环都会残留，不重置会误判
  await send('Page.reload')
  await sleep(5200)
  console.log(`\n=== ${w}x${h} ===`)
  for (const c of CASES) await runCase(size, c)

  // 文件树：展开目录 → 打开文件 → 自动进编辑栏
  await clickNav('文件')
  await sleep(500)
  // 文件树：先滚到顶部，再用 .tree-rows 的高度判断展开（行数在虚拟列表下不可靠）。
  // 点到已展开的目录会折叠，脚本要自己纠正一次。
  const tree = await evaluate(`(() => {
    const scroll = document.querySelector('.tree-scroll')
    if (scroll) scroll.scrollTop = 0
    const row = [...document.querySelectorAll('.tree-row')].find((r) => r.title && /[\\\\/]$/.test(r.title))
    if (!row) return { ok: false, why: '没有目录行' }
    const rows = document.querySelector('.tree-rows')
    const before = rows ? parseInt(rows.style.height || '0', 10) : 0
    row.click()
    return { ok: true, before, dir: row.title }
  })()`)
  let treeAfter = tree.before
  for (let i = 0; i < 8; i += 1) {
    await sleep(300)
    treeAfter = await evaluate(`(() => {
      const rows = document.querySelector('.tree-rows')
      return rows ? parseInt(rows.style.height || '0', 10) : 0
    })()`)
    if (treeAfter !== tree.before) break
  }
  if (tree.ok && treeAfter < tree.before) {
    // 第一次点的是「已展开」的目录，被折叠了：再点回来
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.tree-row')].find((r) => r.title === ${JSON.stringify(tree.dir)})
      if (row) row.click()
      return true
    })()`)
    for (let i = 0; i < 8; i += 1) {
      await sleep(300)
      treeAfter = await evaluate(`(() => {
        const rows = document.querySelector('.tree-rows')
        return rows ? parseInt(rows.style.height || '0', 10) : 0
      })()`)
      if (treeAfter > tree.before) break
    }
  }
  const treeOk = tree.ok && treeAfter > tree.before
  if (!tree.ok) skips.push({ size: `${w}x${h}`, name: '文件树展开', why: tree.why })
  console.log(`${treeOk ? 'PASS' : 'FAIL'}  ${w}x${h}  文件树展开  (高度 ${tree.before} → ${treeAfter}px)`)
  if (tree.ok && !treeOk) failures.push({ size: `${w}x${h}`, name: '文件树展开', problems: [`高度 ${tree.before} → ${treeAfter}`] })

  const opened = await evaluate(`(() => {
    const fileRow = [...document.querySelectorAll('.tree-row')].find((r) => r.title && !/[\\\\/]$/.test(r.title))
    if (!fileRow) return { ok: false }
    fileRow.click()
    return { ok: true, name: fileRow.title }
  })()`)
  await sleep(1500)
  const afterOpen = await evaluate(`({
    pane: document.querySelector('.main')?.dataset.pane,
    tabs: document.querySelectorAll('.file-tab').length,
    editorVisible: getComputedStyle(document.querySelector('.editor-pane')).display !== 'none',
  })`)
  const openOk = opened.ok && afterOpen.pane === 'editor' && afterOpen.tabs > 0
  console.log(`${openOk ? 'PASS' : 'FAIL'}  ${w}x${h}  点文件自动进编辑栏  (${opened.name || '无文件'} → ${JSON.stringify(afterOpen)})`)
  if (opened.ok && !openOk) failures.push({ size: `${w}x${h}`, name: '打开文件', problems: [JSON.stringify(afterOpen)] })

  // 斜杠命令菜单：输入框里打一个 / 应该弹出命令列表
  await clickNav('聊天')
  await sleep(300)
  const slash = await evaluate(`(() => {
    const el = document.querySelector('.chat-input')
    if (!el) return { ok: false, why: '没有输入框' }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, '/')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.focus()
    return { ok: true }
  })()`)
  await sleep(700)
  const slashMenu = await evaluate(`(() => {
    const el = document.querySelector('.chat-slash-menu')
    if (!el) return { found: false }
    const r = el.getBoundingClientRect()
    const items = [...el.querySelectorAll('button, [role="option"], .chat-slash-item')].filter((b) => { const q = b.getBoundingClientRect(); return q.width > 0 && q.height > 0 }).length
    return { found: true, x: Math.round(r.x), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height), items }
  })()`)
  const slashProblems = []
  if (slash.ok) {
    if (!slashMenu.found) slashProblems.push('菜单没出来')
    else {
      if (slashMenu.right > w + 1 || slashMenu.x < -1 || slashMenu.bottom > h + 1) slashProblems.push(`超出屏幕 x=${slashMenu.x} right=${slashMenu.right} bottom=${slashMenu.bottom}`)
      if (slashMenu.items === 0) slashProblems.push('没有命令项')
    }
  }
  console.log(`${slash.ok ? (slashProblems.length ? 'FAIL' : 'PASS') : 'SKIP'}  ${w}x${h}  斜杠命令菜单  (${slash.ok ? `${slashMenu.w}x${slashMenu.h}, ${slashMenu.items} 项` : slash.why})`)
  if (slash.ok && slashProblems.length) failures.push({ size: `${w}x${h}`, name: '斜杠命令', problems: slashProblems })
  await shot(`slash-${w}x${h}`)
  // 清空输入框
  await evaluate(`(() => {
    const el = document.querySelector('.chat-input')
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, '')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    return true
  })()`)
  await sleep(300)

  // 编辑器模式按钮：打开一个 markdown 文件再看工具栏
  await clickNav('文件')
  await sleep(400)
  const md = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.tree-row')].find((r) => r.title && /\.(md|html)$/i.test(r.title))
    if (!row) return { ok: false }
    row.click()
    return { ok: true, name: row.title }
  })()`)
  await sleep(1600)
  const modes = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.editor-modes button')]
    if (!btns.length) return { ok: false, why: '没有模式按钮' }
    const rects = btns.map((b) => b.getBoundingClientRect())
    const out = rects.filter((r) => r.right > innerWidth + 1 || r.x < -1).length
    const small = [...document.querySelectorAll('.editor-toolbar button')]
      .map((b) => b.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0 && (r.height < 24 || r.width < 24)).length
    return { ok: true, count: btns.length, out, small }
  })()`)
  const modeProblems = []
  if (modes.ok) {
    if (modes.out > 0) modeProblems.push(`${modes.out} 个按钮出屏`)
    if (modes.small > 0) modeProblems.push(`${modes.small} 个按钮 <24px`)
  }
  console.log(`${modes.ok ? (modeProblems.length ? 'FAIL' : 'PASS') : 'SKIP'}  ${w}x${h}  编辑器模式按钮  (${modes.ok ? `${modes.count} 个, 出屏 ${modes.out}, 过小 ${modes.small}（${md.name}）` : modes.why})`)
  if (modes.ok && modeProblems.length) failures.push({ size: `${w}x${h}`, name: '编辑器模式', problems: modeProblems })
  await shot(`editor-modes-${w}x${h}`)

  // 主题按钮
  await clickNav('聊天')
  await sleep(300)
  // 主题偏好是 system → light → dark 循环；system 下 data-theme 可能不变，
  // 所以判 data-theme-pref 才是「按钮真的生效」。
  const theme = await evaluate(`(() => {
    const before = document.documentElement.dataset.themePref
    const btn = document.querySelector('.topbar-iconbtn')
    if (!btn) return { ok: false }
    btn.click()
    return { ok: true, before }
  })()`)
  await sleep(500)
  const themeAfter = await evaluate(`document.documentElement.dataset.themePref`)
  const themeOk = theme.ok && themeAfter !== theme.before
  console.log(`${themeOk ? 'PASS' : 'FAIL'}  ${w}x${h}  主题切换  (${theme.before} → ${themeAfter})`)
  if (theme.ok && !themeOk) failures.push({ size: `${w}x${h}`, name: '主题切换', problems: [`pref ${theme.before} 未变化`] })
}

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: false })

// ---------- 网络层：不允许出现 4xx / 5xx ----------
const uniqueErrors = [...new Map(httpErrors.map((e) => [e.status + e.url, e])).values()]
if (uniqueErrors.length === 0) {
  console.log('PASS  网络请求无 4xx/5xx')
} else {
  for (const e of uniqueErrors.slice(0, 10)) console.log('FAIL  HTTP ' + e.status + ' ' + e.url)
  failures.push({
    size: '-',
    name: '网络请求',
    problems: uniqueErrors.slice(0, 5).map((e) => e.status + ' ' + e.url),
  })
}

console.log(`\n失败 ${failures.length} 项，跳过 ${skips.length} 项`)
if (failures.length) {
  console.log('\n失败清单：')
  for (const f of failures) console.log(` - ${f.size} ${f.name}: ${f.problems.join('；')}`)
}
if (skips.length) {
  console.log('\n跳过：')
  for (const s of skips) console.log(` - ${s.size} ${s.name}: ${s.why}`)
}
process.exit(failures.length === 0 ? 0 : 1)
