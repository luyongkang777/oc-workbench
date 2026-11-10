// 聊天里「文件路径可点击」的实测：headless Edge 走 CDP 点真实界面。
//
// 用法：先起 vite（127.0.0.1:5273）并且当前目录里有一个含路径的 assistant 消息，
// 再 `node scripts/verify-filelinks.mjs`。
// 产物：`.tmp/verify-filelinks.png` 截图 + 终端 JSON 结论。

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9334
const APP_URL = 'http://127.0.0.1:5273/'
const OUT_DIR = path.resolve('.tmp')
const PROFILE = path.join(OUT_DIR, 'edge-filelinks')

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

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      throw new Error(`页面异常：${result.exceptionDetails.text}`)
    }
    return result.result.value
  }
}

const HELPERS = `
window.__fl = {
  files() {
    return [...document.querySelectorAll('.md-file')].map((node) => node.textContent || '')
  },
  async waitFiles(min, timeout = 20000) {
    const started = performance.now()
    while (performance.now() - started < timeout) {
      if (this.files().length >= min) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  },
  click(text) {
    const node = [...document.querySelectorAll('.md-file')].find((n) => (n.textContent || '').includes(text))
    if (!node) return false
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  },
  async waitEditorPath(name, timeout = 20000) {
    const started = performance.now()
    while (performance.now() - started < timeout) {
      const shown = document.querySelector('.editor-path')?.textContent || ''
      if (shown.split(/[\\\\/]/).pop() === name) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return false
  },
  flashLine() {
    const line = document.querySelector('.code-line.flash')
    if (!line) return null
    return { no: line.querySelector('.line-no')?.textContent || '', text: (line.textContent || '').slice(0, 80) }
  },
  async waitCodeLine(timeout = 15000) {
    const started = performance.now()
    while (performance.now() - started < timeout) {
      if (document.querySelector('.code-line')) return true
      await new Promise((r) => setTimeout(r, 30))
    }
    return false
  },
  async waitFlash(timeout = 4000) {
    const started = performance.now()
    while (performance.now() - started < timeout) {
      const line = document.querySelector('.code-line.flash')
      if (line) return { no: line.querySelector('.line-no')?.textContent || '', text: (line.textContent || '').slice(0, 80) }
      await new Promise((r) => setTimeout(r, 30))
    }
    return null
  },
  firstLineNo() {
    return document.querySelector('.code-line .line-no')?.textContent || ''
  },
  scrollTop() {
    return document.querySelector('.code-scroll')?.scrollTop ?? -1
  },
  scrollHeight() {
    return document.querySelector('.code-scroll')?.scrollHeight ?? -1
  },
  firstLines(n = 3) {
    return [...document.querySelectorAll('.code-line')].slice(0, n).map((l) => (l.textContent || '').slice(0, 80))
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
  try {
    const version = await (await waitOk(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()
    const targets = await (await waitOk(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page')
    if (!page) throw new Error('没有找到 page target')
    cdp = await Cdp.connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.navigate', { url: APP_URL })
    const target = process.env.FL_TARGET || 'Chat.tsx:20'
    await cdp.eval(`globalThis.__FL_TARGET = ${JSON.stringify(target)}`)

    await sleep(1500)
    const ready = await cdp.eval('document.readyState')
    const attached = await cdp.eval(`document.querySelector('.chat-input') ? true : false`)
    const files = await cdp.eval(`${HELPERS}; window.__fl.files()`)
    const waited = await cdp.eval(`${HELPERS}; window.__fl.waitFiles(1, 25000)`)

    let clicked = false
    let ok = false
    let flash = null
    let lines = []
    let editorPath = ''
    let firstLineNo = ''
    let scrollTop = -1
    let scrollHeight = -1
    if (waited) {
      clicked = await cdp.eval(`${HELPERS}; window.__fl.click(globalThis.__FL_TARGET || 'Chat.tsx:20')`)
      ok = await cdp.eval(`${HELPERS}; window.__fl.waitEditorPath('Chat.tsx', 20000)`)
      const hasLines = await cdp.eval(`${HELPERS}; window.__fl.waitCodeLine(15000)`)
      flash = hasLines ? await cdp.eval(`${HELPERS}; window.__fl.waitFlash(4000)`) : null
      editorPath = await cdp.eval("document.querySelector('.editor-path')?.textContent || ''")
      lines = await cdp.eval(`${HELPERS}; window.__fl.firstLines(2)`)
      firstLineNo = await cdp.eval(`${HELPERS}; window.__fl.firstLineNo()`)
      scrollTop = await cdp.eval(`${HELPERS}; window.__fl.scrollTop()`)
      scrollHeight = await cdp.eval(`${HELPERS}; window.__fl.scrollHeight()`)
    }

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const shotFile = path.join(OUT_DIR, 'verify-filelinks.png')
    writeFileSync(shotFile, Buffer.from(shot.data, 'base64'))

    console.log(
      JSON.stringify(
        { browser: version.Browser, ready, attached, files, waited, clicked, ok, editorPath, firstLineNo, scrollTop, scrollHeight, flash, lines, shot: shotFile },
        null,
        2,
      ),
    )
  } finally {
    try {
      await cdp?.send('Browser.close')
    } catch {
      // 关不掉就直接杀
    }
    edge.kill()
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
