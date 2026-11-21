// 验证 /mcps、/skills 在工作台里能打开清单面板（dev 版：先起 vite 5273）。
// 用法：node scripts/verify-manage.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const APP_URL = 'http://127.0.0.1:5273/'
const DEBUG_PORT = 9271
const OUT_DIR = path.resolve('.tmp')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitOk(url, timeout = 60_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error(`等待超时：${url}`)
    await sleep(300)
  }
}

class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url)
    const cdp = new Cdp(ws)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', reject)
    })
    return cdp
  }
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || '脚本执行失败')
    }
    return res.result.value
  }
  async shot(file) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(res.data, 'base64'))
  }
}

const report = []
function check(name, ok, detail = '') {
  report.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

/** 往输入框打一条斜杠命令：先关掉候选菜单，再回车，直接走 send()。 */
/** 往输入框敲一条斜杠命令再回车（分两步，模拟真人节奏，避免同一 tick 的 state 竞态）。 */
const typeCommand = async (cdp, text) => {
  const typed = await cdp.eval(`(() => {
    const el = document.querySelector('.chat-input')
    if (!el) return 'no-input'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  })()`)
  if (typed !== text) return typed
  await sleep(250)
  return cdp.eval(
    `document.querySelector('.chat-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), 'ok'`,
  )
}

async function waitFor(cdp, expression, timeout = 15_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await cdp.eval(expression)
    if (value) return value
    if (Date.now() > deadline) return null
    await sleep(250)
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  await waitOk(APP_URL)

  const userDataDir = path.join(process.env.TEMP || OUT_DIR, 'ocwb-edge-profile-manage')
  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--disable-gpu',
      '--window-size=1200,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let cdp = null
  try {
    await waitOk(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 20_000)
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
    const page = targets.find((item) => item.type === 'page')
    cdp = await Cdp.connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1200,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })

    const loaded = new Promise((resolve) => {
      const onMsg = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.method === 'Page.loadEventFired') {
          cdp.ws.removeEventListener('message', onMsg)
          resolve()
        }
      }
      cdp.ws.addEventListener('message', onMsg)
    })
    await cdp.send('Page.navigate', { url: APP_URL })
    await loaded
    const reloaded = new Promise((resolve) => {
      const onMsg = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.method === 'Page.loadEventFired') {
          cdp.ws.removeEventListener('message', onMsg)
          resolve()
        }
      }
      cdp.ws.addEventListener('message', onMsg)
    })
    await cdp.eval(
      `window.localStorage.setItem('oc-workbench:root', ${JSON.stringify(path.resolve('.'))})`,
    )
    await cdp.send('Page.reload')
    await reloaded

    const ready = await waitFor(cdp, `!!document.querySelector('.chat-input')`, 30_000)
    check('聊天输入框已渲染', Boolean(ready))
    if (!ready) throw new Error('页面没就绪')

    // ---- /skills ----
    check('输入 /skills 并回车', (await typeCommand(cdp, '/skills')) === 'ok')
    const skillsShown = await waitFor(cdp, `!!document.querySelector('.manage-dialog')`, 20_000)
    check('/skills 打开面板', Boolean(skillsShown))
    await waitFor(
      cdp,
      `(() => {
        const dialog = document.querySelector('.manage-dialog')
        if (!dialog) return false
        const foot = dialog.querySelector('.manage-foot span')?.textContent ?? ''
        return foot !== '' && !foot.includes('读取中')
      })()`,
      30_000,
    )

    const skillState = await cdp.eval(`(() => {
      const dialog = document.querySelector('.manage-dialog')
      if (!dialog) return null
      const rows = dialog.querySelectorAll('.manage-row')
      return {
        title: dialog.querySelector('.manage-title')?.textContent ?? '',
        rows: rows.length,
        firstName: rows[0]?.querySelector('.manage-row-name')?.textContent ?? '',
        count: dialog.querySelector('.manage-foot span')?.textContent ?? '',
        error: dialog.querySelector('.manage-error')?.textContent ?? '',
      }
    })()`)
    check(
      '技能面板有清单',
      Boolean(skillState && skillState.rows > 10),
      JSON.stringify(skillState),
    )
    check('技能条数来自服务端', /共 \d+ 个技能/.test(skillState?.count ?? ''), skillState?.count ?? '')
    await cdp.shot(path.join(OUT_DIR, 'verify-manage-skills.png'))

    // 搜索过滤
    const filtered = await cdp.eval(`(() => {
      const input = document.querySelector('.manage-search-input')
      if (!input) return null
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'ida')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return document.querySelectorAll('.manage-row').length
    })()`)
    await sleep(400)
    const filteredCount = await cdp.eval(`document.querySelectorAll('.manage-row').length`)
    check('搜索框能过滤', filteredCount > 0 && filteredCount < (skillState?.rows ?? 0), `ida → ${filteredCount} 行（原 ${filtered}）`)

    // Esc 关闭
    await cdp.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    )
    const closed = await waitFor(cdp, `!document.querySelector('.manage-dialog')`, 5000)
    check('Esc 关闭面板', Boolean(closed))

    // ---- /mcps ----
    await waitFor(cdp, `!document.querySelector('.manage-dialog')`, 5000)
    await sleep(300)
    check('输入 /mcps 并回车', (await typeCommand(cdp, '/mcps')) === 'ok')
    await sleep(300)
    const mcpShown = await waitFor(cdp, `!!document.querySelector('.manage-dialog')`, 15_000)
    check('/mcps 打开面板', Boolean(mcpShown))
    const mcpState = await cdp.eval(`(() => {
      const dialog = document.querySelector('.manage-dialog')
      if (!dialog) return null
      return {
        title: dialog.querySelector('.manage-title')?.textContent ?? '',
        sub: dialog.querySelector('.manage-sub')?.textContent ?? '',
        rows: dialog.querySelectorAll('.manage-row').length,
        note: dialog.querySelector('.manage-note')?.textContent ?? '',
      }
    })()`)
    check('MCP 面板显示连接统计', /已连接 \d+\/\d+/.test(mcpState?.sub ?? ''), JSON.stringify(mcpState))
    await cdp.shot(path.join(OUT_DIR, 'verify-manage-mcps.png'))

    writeFileSync(
      path.join(OUT_DIR, 'verify-manage.json'),
      JSON.stringify({ report, skillState, mcpState }, null, 2),
    )
  } finally {
    try {
      cdp?.ws.close()
    } catch {
      /* ignore */
    }
    edge.kill()
  }

  const failed = report.filter((item) => !item.ok)
  process.stdout.write(`\n${report.length - failed.length}/${report.length} 通过\n`)
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
