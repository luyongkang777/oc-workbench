// 多模型路由面板验收：起 headless Edge 打开 dev 页面，点开面板 → 选三个模型 →
// 生成配置 → 确认文件与服务端 agent 都出现 → 删除 → 确认都消失。
//
// 用法：先起 vite dev（127.0.0.1:5273），再 `node scripts/verify-router.mjs`。
// 会在测试前后备份/还原 `.opencode/agents/router-*.md`，不会覆盖用户已有配置。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9336
const APP_URL = 'http://127.0.0.1:5273/'
const ROOT = path.resolve('.')
const AGENT_DIR = path.join(ROOT, '.opencode', 'agents')
const NAMES = ['router-main', 'router-worker', 'router-reviewer']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitOk(url, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // 还没起来
    }
    await sleep(250)
  }
  throw new Error(`等待 ${url} 超时`)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.events = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const slot = this.pending.get(message.id)
        if (!slot) return
        this.pending.delete(message.id)
        if (message.error) slot.reject(new Error(JSON.stringify(message.error)))
        else slot.resolve(message.result)
        return
      }
      for (const handler of this.events.get(message.method) || []) handler(message.params)
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    return new Cdp(ws)
  }

  send(method, params = {}) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  once(method, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      const list = this.events.get(method) || []
      const timer = setTimeout(() => reject(new Error(`等待事件 ${method} 超时`)), timeoutMs)
      const handler = (params) => {
        clearTimeout(timer)
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
        resolve(params)
      }
      list.push(handler)
      this.events.set(method, list)
    })
  }

  async eval(expression, timeoutMs = 30_000) {
    const result = await Promise.race([
      this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      sleep(timeoutMs).then(() => {
        throw new Error('Runtime.evaluate 超时')
      }),
    ])
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || '页面脚本执行失败')
    }
    return result.result.value
  }
}

const report = []
function check(name, ok, detail = '') {
  report.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function waitFor(cdp, expression, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await cdp.eval(expression)
      if (value) return value
    } catch {
      // 页面还在重载
    }
    await sleep(150)
  }
  return null
}

// ---- 备份现有配置，结束时还原 ----
const backup = new Map()
for (const name of NAMES) {
  const file = path.join(AGENT_DIR, `${name}.md`)
  if (existsSync(file)) backup.set(name, readFileSync(file, 'utf8'))
}

function restore() {
  for (const name of NAMES) {
    const file = path.join(AGENT_DIR, `${name}.md`)
    if (backup.has(name)) writeFileSync(file, backup.get(name), 'utf8')
    else if (existsSync(file)) rmSync(file, { force: true })
  }
}

mkdirSync(AGENT_DIR, { recursive: true })

const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${path.join(process.env.TEMP || '.tmp', 'ocwb-edge-profile-router')}`,
    '--no-first-run',
    '--disable-gpu',
    '--window-size=1500,950',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let cdp = null
try {
  await waitOk(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
  const page = targets.find((item) => item.type === 'page')
  if (!page) throw new Error('没找到页面目标')
  cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  const loaded = cdp.once('Page.loadEventFired')
  await cdp.send('Page.navigate', { url: APP_URL })
  await loaded

  const reloaded = cdp.once('Page.loadEventFired')
  await cdp.eval(`window.localStorage.setItem('oc-workbench:root', ${JSON.stringify(ROOT)})`)
  await cdp.send('Page.reload')
  await reloaded

  const toggle = await waitFor(cdp, `!!document.querySelector('.router-toggle')`, 25_000)
  check('聊天头部有「路由」按钮', !!toggle)
  if (!toggle) throw new Error('页面没有渲染出路由按钮（项目/连接没起来？）')

  await cdp.eval(`document.querySelector('.router-toggle').click()`)
  const panel = await waitFor(cdp, `!!document.querySelector('.router-panel')`)
  check('点开后出现路由面板', !!panel)

  const selects = await waitFor(
    cdp,
    `(() => {
      const list = [...document.querySelectorAll('.router-model')]
      return list.length === 3 && list.every((s) => s.options.length > 1)
    })()`,
    20_000,
  )
  check('三个角色都有可选模型', !!selects)

  const picked = await cdp.eval(`(() => {
    const list = [...document.querySelectorAll('.router-model')]
    const out = []
    list.forEach((select, i) => {
      const options = [...select.options].filter((o) => o.value !== '')
      const chosen = options[i] || options[0]
      if (!chosen) return
      select.value = chosen.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
      out.push(chosen.textContent.trim())
    })
    return out
  })()`)
  check('选中主脑/执行体/审核体三个不同模型', picked.length === 3 && new Set(picked).size === 3, picked.join(' | '))

  await cdp.eval(`document.querySelector('.router-primary').click()`)
  const note = await waitFor(
    cdp,
    `(() => {
      const error = document.querySelector('.router-error')
      if (error) return 'ERROR:' + error.textContent
      const note = document.querySelector('.router-note')
      return note ? note.textContent : ''
    })()`,
    25_000,
  )
  check('点击生成后没有报错', typeof note === 'string' && !note.startsWith('ERROR'), String(note))

  const files = NAMES.map((name) => path.join(AGENT_DIR, `${name}.md`))
  check(
    '三个 agent 文件已落盘',
    files.every((file) => existsSync(file)),
    files.map((file) => `${path.basename(file)}=${existsSync(file)}`).join(' '),
  )

  const mainContent = existsSync(files[0]) ? readFileSync(files[0], 'utf8') : ''
  check('主脑文件是 primary 且带 model', /^mode: primary$/m.test(mainContent) && /^model: /m.test(mainContent))

  // 写盘到服务端认出之间有几个百毫秒，轮询等它出现，避免时序假失败
  const ids = await waitFor(
    cdp,
    `fetch('/api/agent?location%5Bdirectory%5D=' + encodeURIComponent(${JSON.stringify(ROOT)}))
      .then((r) => r.json())
      .then((body) => {
        const list = (body.data || []).map((a) => a.id)
        return list.includes('router-main') ? list : ''
      })`,
    8000,
  )
  check(
    '服务端 /api/agent 能看见三个路由 agent',
    NAMES.every((name) => Array.isArray(ids) && ids.includes(name)),
    Array.isArray(ids) ? ids.filter((id) => id.startsWith('router-')).join(',') : 'no-data',
  )

  const danger = await waitFor(cdp, `!!document.querySelector('.router-danger')`)
  check('已启用后出现「删除配置」', !!danger)
  if (danger) {
    await cdp.eval(`document.querySelector('.router-danger').click()`)
    const confirm = await waitFor(
      cdp,
      `(() => {
        const button = document.querySelector('.router-danger')
        return button && button.textContent.includes('确认删除')
      })()`,
    )
    check('删除需要二次确认', !!confirm)
    await cdp.eval(`document.querySelector('.router-danger').click()`)
    const gone = await waitFor(
      cdp,
      `(() => {
        const note = document.querySelector('.router-note')
        return note && note.textContent.includes('已删除') ? note.textContent : ''
      })()`,
      20_000,
    )
    check('删除后给出成功提示', !!gone)
    check('三个文件已被删除', files.every((file) => !existsSync(file)))
  }
} catch (error) {
  check('验收脚本完整跑完', false, error instanceof Error ? error.message : String(error))
} finally {
  restore()
  if (cdp) cdp.ws.close()
  edge.kill()
}

const failed = report.filter((item) => !item.ok).length
console.log(`\n${report.length - failed} / ${report.length} 项通过`)
process.exit(failed === 0 ? 0 : 1)
