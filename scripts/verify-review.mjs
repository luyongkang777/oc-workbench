// 审查面板正常路径的实测（不是压力仓库）：文件列表、选中、切换、diff 渲染。
//
// 用法：先起 vite（127.0.0.1:5273），再 `node scripts/verify-review.mjs`。

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9336
const APP_URL = 'http://127.0.0.1:5273/'
const OUT_DIR = path.resolve('.tmp')
const PROFILE = path.join(OUT_DIR, 'edge-review')
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
      new Promise((_, reject) => setTimeout(() => reject(new Error('页面无响应（eval 超时）')), timeoutMs)),
    ])
    if (result.exceptionDetails) throw new Error(`页面异常：${result.exceptionDetails.text}`)
    return result.result.value
  }
}

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

    out.panel = await cdp.eval(
      `(async () => {
        const t0 = performance.now()
        document.querySelector('.review-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        const started = performance.now()
        while (performance.now() - started < 15000) {
          if (document.querySelector('.review-item') || document.querySelector('.review-empty')) break
          await new Promise((r) => setTimeout(r, 50))
        }
        while (performance.now() - started < 15000 && !document.querySelector('.diff-line')) {
          await new Promise((r) => setTimeout(r, 50))
        }
        return {
          ms: Math.round(performance.now() - t0),
          files: document.querySelectorAll('.review-item').length,
          totalText: document.querySelector('.review-count')?.textContent || '',
          diffLines: document.querySelectorAll('.diff-line').length,
          selected: document.querySelector('.review-diff-head')?.textContent || '',
          empty: document.querySelector('.review-empty')?.textContent || '',
          domNodes: document.querySelectorAll('*').length,
        }
      })()`,
    )

    out.switch = await cdp.eval(
      `(async () => {
        const items = [...document.querySelectorAll('.review-item')]
        if (items.length < 2) return { ok: false, reason: 'less than 2 files' }
        const before = document.querySelector('.review-diff-head')?.textContent || ''
        items[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
        const started = performance.now()
        while (performance.now() - started < 10000) {
          const now = document.querySelector('.review-diff-head')?.textContent || ''
          if (now && now !== before) {
            await new Promise((r) => setTimeout(r, 120))
            return { ok: true, before, after: now, lines: document.querySelectorAll('.diff-line').length }
          }
          await new Promise((r) => setTimeout(r, 40))
        }
        return { ok: false, reason: 'head did not change' }
      })()`,
    )

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const shotFile = path.join(OUT_DIR, 'verify-review.png')
    writeFileSync(shotFile, Buffer.from(shot.data, 'base64'))
    out.shot = shotFile
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
