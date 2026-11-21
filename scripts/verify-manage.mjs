// 验证 /mcps、/skills 的展示与操作（dev 版：先起 vite 5273）。
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

const setDraft = (value) => `(() => {
  const el = document.querySelector('.chat-input')
  if (!el) return 'no-input'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return el.value
})()`

/** 用真实鼠标事件点某个服务器行里的按钮（合成 .click() 在 headless 下不触发 React onClick）。 */
async function clickRowButton(cdp, name, label) {
  const rect = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.manage-row')]
    const row = rows.find((r) => (r.querySelector('.manage-row-name')?.textContent ?? '').includes(${JSON.stringify(name)}))
    if (!row) return null
    const btn = [...row.querySelectorAll('.manage-mini')].find((b) => b.textContent === ${JSON.stringify(label)})
    if (!btn) return null
    // 行会随状态重排（已停用排最后），可能滚出可视区：先滚到中间再取坐标
    btn.scrollIntoView({ block: 'center' })
    const r = btn.getBoundingClientRect()
    const x = r.x + r.width / 2
    const y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    if (hit !== btn) return { blocked: hit ? hit.className : 'null' }
    return { x, y }
  })()`)
  if (!rect) return 'no-btn'
  if (rect.blocked !== undefined) return `blocked:` + rect.blocked
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: rect.x,
    y: rect.y,
    button: 'left',
    clickCount: 1,
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: rect.x,
    y: rect.y,
    button: 'left',
    clickCount: 1,
  })
  return 'ok'
}

async function waitFor(cdp, expression, timeout = 20_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await cdp.eval(expression)
    if (value) return value
    if (Date.now() > deadline) return null
    await sleep(250)
  }
}

/** 选中一个「失败」的服务器行（不动已连上的，避免影响用户正在用的工具）。 */
const pickFailedRow = () => `(() => {
  const rows = [...document.querySelectorAll('.manage-row')]
  const failed = rows.filter((row) => {
    const tag = row.querySelector('.manage-row-tag')?.textContent ?? ''
    return tag.includes('失败') || tag.includes('授权')
  })
  const row = failed.find((r) => (r.querySelector('.manage-row-name')?.textContent ?? '').includes('edge')) ?? failed[0]
  return row ? (row.querySelector('.manage-row-name')?.textContent ?? '') : null
})()`

const rowTag = (name) => `(() => {
  const rows = [...document.querySelectorAll('.manage-row')]
  const row = rows.find((r) => (r.querySelector('.manage-row-name')?.textContent ?? '').includes(${JSON.stringify(name)}))
  return row ? (row.querySelector('.manage-row-tag')?.textContent ?? '') : ''
})()`

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

    const waitLoad = () =>
      new Promise((resolve) => {
        const onMsg = (event) => {
          const msg = JSON.parse(event.data)
          if (msg.method === 'Page.loadEventFired') {
            cdp.ws.removeEventListener('message', onMsg)
            resolve()
          }
        }
        cdp.ws.addEventListener('message', onMsg)
      })

    let loaded = waitLoad()
    await cdp.send('Page.navigate', { url: APP_URL })
    await loaded
    loaded = waitLoad()
    await cdp.eval(
      `window.localStorage.setItem('oc-workbench:root', ${JSON.stringify(path.resolve('.'))})`,
    )
    await cdp.send('Page.reload')
    await loaded

    const ready = await waitFor(cdp, `!!document.querySelector('.chat-input')`, 30_000)
    check('聊天输入框已渲染', Boolean(ready))
    if (!ready) throw new Error('页面没就绪')

    // ---------------- /skills ----------------
    check('输入 /skills 并回车', (await typeCommand(cdp, '/skills')) === 'ok')
    check('/skills 打开面板', Boolean(await waitFor(cdp, `!!document.querySelector('.manage-dialog')`)))

    await waitFor(
      cdp,
      `(() => {
        const foot = document.querySelector('.manage-foot span')?.textContent ?? ''
        return foot !== '' && !foot.includes('读取中')
      })()`,
      30_000,
    )
    const skillState = await cdp.eval(`(() => {
      const dialog = document.querySelector('.manage-dialog')
      if (!dialog) return null
      return {
        rows: dialog.querySelectorAll('.manage-row').length,
        count: dialog.querySelector('.manage-foot span')?.textContent ?? '',
        error: dialog.querySelector('.manage-error')?.textContent ?? '',
      }
    })()`)
    check('技能面板有清单', Boolean(skillState && skillState.rows > 10), JSON.stringify(skillState))

    // 搜索
    await cdp.eval(`(() => {
      const input = document.querySelector('.manage-search-input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'ida')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(400)
    const filtered = await cdp.eval(`document.querySelectorAll('.manage-row').length`)
    check('搜索框能过滤', filtered > 0 && filtered < (skillState?.rows ?? 0), `ida → ${filtered} 行`)

    // 清空搜索后展开第一行看全文
    await cdp.eval(`(() => {
      const input = document.querySelector('.manage-search-input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(300)
    await cdp.eval(`document.querySelector('.manage-row-btn')?.click()`)
    const docLen = await waitFor(
      cdp,
      `(() => {
        const doc = document.querySelector('.manage-doc')
        return doc ? doc.textContent.length : 0
      })()`,
      10_000,
    )
    check('点技能能看 SKILL.md 全文', Number(docLen) > 200, `正文 ${docLen} 字`)
    await cdp.shot(path.join(OUT_DIR, 'verify-manage-skill-detail.png'))

    // 插入到对话
    const insertClicked = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('.manage-doc-actions .manage-mini')].find((b) => b.textContent === '插入到对话')
      if (!btn) return 'no-btn'
      btn.click()
      return 'ok'
    })()`)
    check('点「插入到对话」', insertClicked === 'ok')
    const inserted = await waitFor(
      cdp,
      `(() => {
        const value = document.querySelector('.chat-input')?.value ?? ''
        return value.includes('请用 skill 工具加载技能') ? value : ''
      })()`,
      5000,
    )
    check('插入后关闭面板并写好提示词', Boolean(inserted), String(inserted).slice(0, 60))
    await cdp.eval(setDraft(''))
    await cdp.shot(path.join(OUT_DIR, 'verify-manage-after-insert.png'))

    // ---------------- /mcps ----------------
    await sleep(300)
    check('输入 /mcps 并回车', (await typeCommand(cdp, '/mcps')) === 'ok')
    check('/mcps 打开面板', Boolean(await waitFor(cdp, `!!document.querySelector('.manage-dialog')`)))
    await waitFor(cdp, `!!document.querySelector('.manage-sub')`, 10_000)

    const mcpState = await cdp.eval(`(() => {
      const dialog = document.querySelector('.manage-dialog')
      if (!dialog) return null
      return {
        sub: dialog.querySelector('.manage-sub')?.textContent ?? '',
        rows: dialog.querySelectorAll('.manage-row').length,
        hasReconnectAll: [...dialog.querySelectorAll('.manage-btn')].some((b) => b.textContent.includes('全部重连')),
      }
    })()`)
    check('MCP 面板显示连接统计', /已连接 \d+\/\d+/.test(mcpState?.sub ?? ''), JSON.stringify(mcpState))
    check('有「全部重连」入口', Boolean(mcpState?.hasReconnectAll))

    // 断开一个失败中的服务器 → 状态变「已停用」
    const target = await cdp.eval(pickFailedRow())
    check('选中一个失败的服务器', Boolean(target), target ?? '无')
    if (target) {
      check('点「断开」', (await clickRowButton(cdp, target, '断开')) === 'ok', target)
      const disabled = await waitFor(
        cdp,
        `(() => {
          const tag = ${rowTag(target)}
          return tag.includes('已停用')
        })()`,
        20_000,
      )
      check('断开后状态变「已停用」', Boolean(disabled))

      check('点「连接」重连', (await clickRowButton(cdp, target, '连接')) === 'ok')
      const reconnected = await waitFor(
        cdp,
        `(() => {
          const tag = ${rowTag(target)}
          return tag !== '' && !tag.includes('已停用')
        })()`,
        25_000,
      )
      check('重连后离开「已停用」', Boolean(reconnected), await cdp.eval(rowTag(target)))
    }

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
