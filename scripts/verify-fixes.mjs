// 本轮修复的实测：大 Markdown 默认源码、审查视图下点文件要切回代码视图。
//
// 用法：先起 vite，仓库根有 big-preview.md（≥1MB）。`node scripts/verify-fixes.mjs`

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9337
const APP_URL = 'http://127.0.0.1:5273/'
const OUT_DIR = path.resolve('.tmp')
const PROFILE = path.join(OUT_DIR, 'edge-fixes')
const ROOT = 'F:\\opencode\\workbench'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitOk(url, timeoutMs = 40_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
    } catch {
      // 还没起来
    }
    await sleep(200)
  }
  throw new Error(`等待 ${url} 超时`)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id) return
      const slot = this.pending.get(message.id)
      if (!slot) return
      this.pending.delete(message.id)
      if (message.error) slot.reject(new Error(JSON.stringify(message.error)))
      else slot.resolve(message.result)
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

  async eval(expression, timeoutMs = 25_000) {
    const result = await Promise.race([
      this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('页面无响应')), timeoutMs)),
    ])
    if (result.exceptionDetails) throw new Error(`页面异常：${result.exceptionDetails.text}`)
    return result.result.value
  }
}

const HELPERS = `
window.__fx = {
  rows() { return [...document.querySelectorAll('.tree-row')] },
  rowByName(name) { return this.rows().find(r => (r.querySelector('.tree-name')?.textContent || '') === name) },
  async waitRow(name, timeout = 20000) {
    const started = performance.now()
    while (performance.now() - started < timeout) {
      if (this.rowByName(name)) return true
      await new Promise(r => setTimeout(r, 100))
    }
    return false
  },
  clickRow(name) {
    const row = this.rowByName(name)
    if (!row) return false
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  },
  async waitEditor(name, timeout = 20000) {
    const started = performance.now()
    while (performance.now() - started < timeout) {
      const shown = document.querySelector('.editor-path')?.textContent || ''
      if (shown.split(/[\\\\/]/).pop() === name) return true
      await new Promise(r => setTimeout(r, 50))
    }
    return false
  },
  async waitLines(timeout = 20000) {
    const started = performance.now()
    while (performance.now() - started < timeout) {
      if (document.querySelector('.code-line')) return true
      await new Promise(r => setTimeout(r, 50))
    }
    return false
  },
  async waitIdle(timeout = 20000) {
    const started = performance.now()
    while (performance.now() - started < timeout) {
      const text = document.querySelector('.editor-empty')?.textContent || ''
      if (!text.includes('读取中')) return true
      await new Promise(r => setTimeout(r, 50))
    }
    return false
  },
  state() {
    return {
      path: document.querySelector('.editor-path')?.textContent || '',
      codeLines: document.querySelectorAll('.code-line').length,
      note: document.querySelector('.editor-note')?.textContent || '',
      preview: !!document.querySelector('.editor-preview'),
      reviewActive: !!document.querySelector('.review-toggle.active'),
      reviewPanel: !!document.querySelector('.review'),
      modeButtons: [...document.querySelectorAll('.toolbar-mode, .code-toolbar button')].map(b => b.textContent).filter(Boolean),
    }
  },
}
true
`

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--window-size=1600,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let cdp
  const out = {}
  try {
    await waitOk(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    const targets = await (await waitOk(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page')
    cdp = await Cdp.connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.navigate', { url: APP_URL })
    await sleep(1200)
    await cdp.eval(`window.localStorage.setItem('oc-workbench:root', ${JSON.stringify(ROOT)})`)
    await cdp.send('Page.reload')
    await sleep(1500)

    out.largeMarkdown = await cdp.eval(
      `(async () => {
        ${HELPERS}
        if (!(await window.__fx.waitRow('big-preview.md'))) return { ok: false, reason: 'row missing' }
        window.__fx.clickRow('big-preview.md')
        const opened = await window.__fx.waitEditor('big-preview.md')
        const lines = await window.__fx.waitLines(15000)
        await new Promise(r => setTimeout(r, 400))
        return { ok: opened, lines, state: window.__fx.state() }
      })()`,
      45_000,
    )

    // 切到审查视图，再点文件树 → 应该自动切回代码视图并显示该文件
    out.reviewSwitch = await cdp.eval(
      `(async () => {
        ${HELPERS}
        document.querySelector('.review-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await new Promise(r => setTimeout(r, 800))
        const inReview = !!document.querySelector('.review')
        if (!(await window.__fx.waitRow('README.md'))) return { ok: false, reason: 'row missing', inReview }
        window.__fx.clickRow('README.md')
        const opened = await window.__fx.waitEditor('README.md')
        await new Promise(r => setTimeout(r, 400))
        return { ok: opened, inReview, state: window.__fx.state() }
      })()`,
      45_000,
    )

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    out.shot = path.join(OUT_DIR, 'verify-fixes.png')
    writeFileSync(out.shot, Buffer.from(shot.data, 'base64'))
  } finally {
    try {
      await cdp?.send('Browser.close')
    } catch {
      // 关不掉就杀
    }
    edge.kill()
  }

  console.log(JSON.stringify(out, null, 2))
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
