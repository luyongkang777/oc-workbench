// 强制规则面板的真机验收（Edge CDP）。
//
// 断言的是「页面上真发生了」：面板能开、条目能读到、能新增单行/两行条目、
// 保存后文件真的落盘成 JSON 条目，AI 用的序号口径与面板一致。
//
// 用法：node scripts/verify-rules.mjs 9234
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'

const port = Number(process.argv[2] || 9234)
const FIXED_ORIGIN = process.env.OC_RULES_ORIGIN || ''
// 用独立临时项目目录：验收会增删条目，绝不能碰用户真实的 .opencode/rules.json
const ROOT = 'F:\\opencode\\workbench\\.tmp\\rules-verify-project'
const SINGLE_ROW = '验收用单行规则：改完必须跑 npm test'
const TITLED_ROW = { title: '行尾', text: '只能用 LF' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targetWs() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('没有可用的页面 target')
  return page.webSocketDebuggerUrl
}

class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
        else entry.resolve(msg.result)
      }
    })
  }
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    return new Session(ws)
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'evaluate 异常')
    return res.result?.value
  }
}

async function waitFor(session, expression, label, timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await session.eval(expression).catch(() => null)
    if (value) return value
    await sleep(250)
  }
  throw new Error(`等待超时：${label}`)
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

await mkdir(`${ROOT}\\.opencode`, { recursive: true })
await rm(`${ROOT}\\.opencode\\rules.json`, { force: true })
await rm(`${ROOT}\\.opencode\\rules.md`, { force: true })

const session = await Session.open(await targetWs())
await session.send('Runtime.enable')
await session.send('Page.enable')
await session.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('oc-workbench:root', ${JSON.stringify(ROOT)}) } catch {}`,
})
if (FIXED_ORIGIN) {
  await session.send('Page.navigate', { url: `${FIXED_ORIGIN}/?verify-rules=1` })
  await sleep(4500)
} else {
  await sleep(800)
}

const ORIGIN = await session.eval('location.origin')
if (!ORIGIN) throw new Error('读不到页面 origin')
console.log('origin:', ORIGIN)

await waitFor(session, `!!document.querySelector('.app')`, '主界面挂载')
await waitFor(session, `!!document.querySelector('.topbar')`, '顶栏渲染')

const hasButton = await session.eval(
  `!!document.querySelector('button[aria-label="强制规则：全局与当前目录"]')`,
)
check('顶栏有规则入口', hasButton)

await session.eval(`document.querySelector('button[aria-label="强制规则：全局与当前目录"]').click()`)
await waitFor(session, `!!document.querySelector('.rules-panel.open')`, '规则面板打开')
check('点击后规则面板打开', true)

const noteText = await session.eval(`document.querySelector('.rules-note')?.textContent || ''`)
check(
  '面板说明强制 + 可让 AI 写',
  /强制/.test(noteText) && /没有开关/.test(noteText) && /rules_add/.test(noteText),
  noteText.slice(0, 26),
)

// 切到当前目录，从空列表开始
await session.eval(`[...document.querySelectorAll('.rules-tab')].find(b=>b.textContent.includes('当前目录')).click()`)
await sleep(600)
const rowCount = await session.eval(`document.querySelectorAll('.rules-item').length`)
const hasList = await session.eval(`!!document.querySelector('.rules-list')`)
check('目录条目区域已渲染（条目形态，不是一大块）', hasList, `当前 ${rowCount} 条`)

// 加一条单行规则
await session.eval(`[...document.querySelectorAll('.rules-btn')].find(b=>b.textContent.includes('单行')).click()`)
await sleep(400)
const rowsAfterAdd = await session.eval(`document.querySelectorAll('.rules-item').length`)
check('「＋ 单行」增加了一个条目', rowsAfterAdd === rowCount + 1, `${rowCount} → ${rowsAfterAdd}`)

// 把最后一条填成单行规则
await session.eval(`(() => {
  const rows = document.querySelectorAll('.rules-item')
  const row = rows[rows.length - 1]
  const ta = row.querySelector('.rules-item-text')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, ${JSON.stringify(SINGLE_ROW)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(300)

// 再加一条「标题+内容」
await session.eval(`[...document.querySelectorAll('.rules-btn')].find(b=>b.textContent.includes('标题+内容')).click()`)
await sleep(400)
await session.eval(`(() => {
  const rows = document.querySelectorAll('.rules-item')
  const row = rows[rows.length - 1]
  const input = row.querySelector('.rules-item-title')
  const ta = row.querySelector('.rules-item-text')
  const iset = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  const tset = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  iset.call(input, ${JSON.stringify(TITLED_ROW.title)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  tset.call(ta, ${JSON.stringify(TITLED_ROW.text)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(400)

const saveEnabled = await session.eval(
  `!([...document.querySelectorAll('.rules-btn')].find(b=>b.textContent.trim()==='保存')).disabled`,
)
check('改动后保存按钮可用', saveEnabled)

await session.eval(`[...document.querySelectorAll('.rules-btn')].find(b=>b.textContent.trim()==='保存').click()`)
await sleep(1500)
const savedMsg = await session.eval(`document.querySelector('.rules-msg')?.textContent || ''`)
check('保存后有成功提示并报条数', /已保存/.test(savedMsg), savedMsg)

// 落盘校验：JSON 条目 + 两种形态都对
const status = await (
  await fetch(`${ORIGIN}/local/rules/status?directory=${encodeURIComponent(ROOT)}`)
).json()
const texts = status.local.items.map((i) => i.text)
const titled = status.local.items.find((i) => i.title === TITLED_ROW.title)
check('单行条目已落盘', texts.includes(SINGLE_ROW))
check('标题+内容条目已落盘', Boolean(titled) && titled.text === TITLED_ROW.text, JSON.stringify(titled))

const raw = JSON.parse(await readFile(`${ROOT}\\.opencode\\rules.json`, 'utf8'))
check('文件是 JSON 条目格式', Array.isArray(raw.items) && raw.items.length >= 2, `items=${raw.items?.length}`)

const coverage = await session.eval(`document.querySelector('.rules-coverage')?.textContent || ''`)
check('面板显示覆盖级别与条数', /共 \d+ 条/.test(coverage), coverage)

// 删除刚加的两条，避免测试数据留在真实规则里
// 只删本脚本加的那两条：按内容定位，一次删一条（React 重渲染后旧节点会失效，
// 一次性点多个按钮只会生效第一个）。绝不按位置删，避免误删真实规则。
for (let guard = 0; guard < 6; guard++) {
  const clicked = await session.eval(`(() => {
    const rows = [...document.querySelectorAll('.rules-item')]
    const mine = rows.find((row) => {
      const title = row.querySelector('.rules-item-title')?.value ?? ''
      const text = row.querySelector('.rules-item-text')?.value ?? ''
      return text.trim() === "验收用单行规则：改完必须跑 npm test" || title.trim() === "行尾"
    })
    if (!mine) return false
    mine.querySelector('.rules-item-del')?.click()
    return true
  })()`)
  if (!clicked) break
  await sleep(250)
}
await sleep(400)
await session.eval(`[...document.querySelectorAll('.rules-btn')].find(b=>b.textContent.trim()==='保存').click()`)
await sleep(1400)
const after = await (
  await fetch(`${ORIGIN}/local/rules/status?directory=${encodeURIComponent(ROOT)}`)
).json()
check('删除条目并保存后该页为空', after.local.items.length === 0, `剩 ${after.local.items.length} 条`)

// 9) 关闭 → 外部写入（等价于 AI 的 rules_add）→ 重新打开必须看到新条目。
// 这条防的是「面板只在挂载时拉一次」：工作台启动后写入的规则会永远显示不出来。
await session.eval(`document.querySelector('.rules-close').click()`)
await sleep(400)
const beforeReopen = await session.eval(`document.querySelectorAll('.rules-item').length`)
const current = await (
  await fetch(`${ORIGIN}/local/rules/status?directory=${encodeURIComponent(ROOT)}`)
).json()
const seeded = await (
  await fetch(`${ORIGIN}/local/rules/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'local',
      directory: ROOT,
      items: [...current.local.items, { title: '刷新测试', text: '外部写入后重新打开应能看到' }],
    }),
  })
).json()
await session.eval(`document.querySelector('button[aria-label="强制规则：全局与当前目录"]').click()`)
await sleep(900)
await session.eval(`[...document.querySelectorAll('.rules-tab')].find(b=>b.textContent.includes('当前目录')).click()`)
await sleep(700)
const afterReopen = await session.eval(`document.querySelectorAll('.rules-item').length`)
check(
  '重新打开面板能读到外部写入的条目',
  afterReopen === seeded.local.items.length && afterReopen > beforeReopen,
  `${beforeReopen} → ${afterReopen}`,
)
// 清理刚写入的测试条目
await fetch(`${ORIGIN}/local/rules/save`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    scope: 'local',
    directory: ROOT,
    items: seeded.local.items.filter((i) => i.title !== '刷新测试'),
  }),
})

// Esc 用 JS 在 window 上派发：面板监听的就是 window keydown。
// CDP 的 Input.dispatchKeyEvent 在刚保存完的重渲染窗口里偶尔丢失（实测两次），
// 用 JS 派发测的是同一个处理函数，判定更稳。
await sleep(600)
await session.eval(
  `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
)
await sleep(600)
const stillOpen = await session.eval(`!!document.querySelector('.rules-panel.open')`)
check('Esc 能关闭面板', !stillOpen)

const shot = await session.send('Page.captureScreenshot', { format: 'png' })
await writeFile('.tmp/verify-rules.png', Buffer.from(shot.data, 'base64'))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
// 必须显式关连接：留着 WebSocket 会让 Node 事件循环不退出，
// 调用方（PowerShell 管道）就一直等 EOF，看起来像脚本卡死。
session.ws.close()
if (failed.length) {
  console.log('失败项：' + failed.map((r) => r.name).join(', '))
  process.exit(1)
}
process.exit(0)
