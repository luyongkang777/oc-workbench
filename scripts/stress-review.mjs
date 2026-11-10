// 审查面板压力实测：401 个文件 / 5.4MB diff / 单文件 6 万行 patch。
//
// 用法：先起 vite（127.0.0.1:5273），仓库在 `.tmp/stress-repo`。
// `node scripts/stress-review.mjs` → 输出耗时、DOM 节点、内存、页面是否还响应。
// 可选 `STRESS_KEEP_ROOT=1` 保留 localStorage 里的 root（默认会还原）。

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9335
const APP_URL = 'http://127.0.0.1:5273/'
const OUT_DIR = path.resolve('.tmp')
const PROFILE = path.join(OUT_DIR, 'edge-stress')
const STRESS_ROOT = 'F:\\opencode\\workbench\\.tmp\\stress-repo'

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

  /** eval 带硬超时：页面真卡死时不能把脚本也拖住。 */
  async eval(expression, timeoutMs = 20_000) {
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
  const result = { root: STRESS_ROOT }
  try {
    await waitOk(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    const targets = await (await waitOk(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page')
    cdp = await Cdp.connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.navigate', { url: APP_URL })
    await sleep(1200)

    // 把工作区根指到压力仓库，重载页面
    const prevRoot = await cdp.eval("window.localStorage.getItem('oc-workbench:root') || ''")
    result.prevRoot = prevRoot
    await cdp.eval(`window.localStorage.setItem('oc-workbench:root', ${JSON.stringify(STRESS_ROOT)})`)
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(1500)

    // 等文件树把压力仓库读出来（根目录显示 stress-repo 的名字）
    const treeReady = await cdp.eval(
      `(async () => {
        const started = performance.now()
        while (performance.now() - started < 20000) {
          if (document.querySelector('.tree-row')) return true
          await new Promise(r => setTimeout(r, 100))
        }
        return false
      })()`,
    )
    result.treeReady = treeReady

    // 计时：点「审查」→ 首个 .diff-line 出现 → 行数与 DOM 总量
    const measured = await cdp.eval(
      `(async () => {
        const out = { clicked: false, firstLineMs: null, lines: 0, domNodes: 0, heapBytes: 0, error: null }
        const toggle = document.querySelector('.review-toggle')
        if (!toggle) { out.error = 'no .review-toggle'; return out }
        const t0 = performance.now()
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        out.clicked = true
        while (performance.now() - t0 < 30000) {
          if (document.querySelector('.diff-line')) { out.firstLineMs = Math.round(performance.now() - t0); break }
          await new Promise(r => setTimeout(r, 50))
        }
        out.lines = document.querySelectorAll('.diff-line').length
        out.domNodes = document.querySelectorAll('*').length
        out.heapBytes = performance.memory ? performance.memory.usedJSHeapSize : 0
        out.reviewFiles = document.querySelectorAll('.review-item').length
        out.emptyText = document.querySelector('.review-empty')?.textContent || ''
        return out
      })()`,
      45_000,
    )
    Object.assign(result, measured)

    // 页面还活着吗：量一次同步任务耗时
    result.responsiveMs = await cdp.eval(
      `(() => { const t = performance.now(); let s = 0; for (let i = 0; i < 2e6; i += 1) s += i; return Math.round(performance.now() - t) })()`,
      20_000,
    ).catch((err) => err.message)

    // 切到最大的那个文件（huge_module.ts）再测一轮：单文件 6 万行
    const huge = await cdp.eval(
      `(async () => {
        const item = [...document.querySelectorAll('.review-item')].find(n => (n.textContent || '').includes('huge_module'))
        if (!item) return { found: false }
        const t0 = performance.now()
        item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        while (performance.now() - t0 < 30000) {
          if ((document.querySelector('.diff-body')?.textContent || '').includes('huge_0')) {
            return { found: true, ms: Math.round(performance.now() - t0), lines: document.querySelectorAll('.diff-line').length, domNodes: document.querySelectorAll('*').length }
          }
          await new Promise(r => setTimeout(r, 50))
        }
        return { found: true, ms: null, lines: document.querySelectorAll('.diff-line').length, domNodes: document.querySelectorAll('*').length }
      })()`,
      45_000,
    )
    result.huge = huge

    // 虚拟滚动位置正确性：中间位置和底部各看一次
    result.scrollCheck = await cdp.eval(
      `(async () => {
        const scroller = document.querySelector('.diff-scroll')
        if (!scroller) return { ok: false, reason: 'no scroller' }
        const lineHeight = 18
        const probe = 40000
        const t0 = performance.now()
        for (let i = 0; i < 20; i += 1) {
          scroller.scrollTop = (probe + i * 50) * lineHeight
          await new Promise((r) => requestAnimationFrame(() => r(null)))
        }
        const avgFrameMs = Math.round((performance.now() - t0) / 20)
        scroller.scrollTop = probe * lineHeight
        await new Promise((r) => setTimeout(r, 120))
        const mid = [...document.querySelectorAll('.diff-line')].map((n) => n.textContent)
        scroller.scrollTop = scroller.scrollHeight
        await new Promise((r) => setTimeout(r, 150))
        const tail = [...document.querySelectorAll('.diff-line')].map((n) => n.textContent)
        // 文件列表自己也滚到底：应该看到最后一批 module_399 附近的项
        const list = document.querySelector('.review-list')
        let listCheck = { ok: false }
        if (list) {
          list.scrollTop = list.scrollHeight
          await new Promise((r) => setTimeout(r, 150))
          const names = [...document.querySelectorAll('.review-file')].map((n) => n.textContent)
          listCheck = {
            ok: true,
            rendered: names.length,
            last: names.slice(-2),
            hasLastFile: names.some((t) => t.includes('module_399')),
          }
        }
        return {
          ok: true,
          avgFrameMs,
          renderedLines: mid.length,
          domNodes: document.querySelectorAll('*').length,
          midFirst: mid.slice(0, 2).map((t) => t.slice(0, 44)),
          midLast: mid.slice(-2).map((t) => t.slice(0, 44)),
          tailLast: tail.slice(-2).map((t) => t.slice(0, 44)),
          tailHasLastLine: tail.some((t) => t.includes('huge_29999')),
          hasCarriageReturn: mid.some((t) => t.charCodeAt(t.length - 1) === 13),
          list: listCheck,
        }
      })()`,
      30_000,
    )

    // 5.4MB diff 单独拉一次的耗时（含 JSON 解析），定位首帧时间花在哪
    result.fetchMs = await cdp.eval(
      `(async () => {
        const t0 = performance.now()
        const res = await fetch('/api/vcs/diff?location%5Bdirectory%5D=F%3A%5Copencode%5Cworkbench%5C.tmp%5Cstress-repo&mode=working', { cache: 'no-store' })
        const data = await res.json()
        return { ms: Math.round(performance.now() - t0), bytes: res.headers.get('content-length'), files: (data.data || []).length }
      })()`,
      45_000,
    )

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const shotFile = path.join(OUT_DIR, 'stress-review.png')
    writeFileSync(shotFile, Buffer.from(shot.data, 'base64'))
    result.shot = shotFile

    if (!process.env.STRESS_KEEP_ROOT) {
      if (prevRoot) await cdp.eval(`window.localStorage.setItem('oc-workbench:root', ${JSON.stringify(prevRoot)})`)
      else await cdp.eval("window.localStorage.removeItem('oc-workbench:root')")
    }
  } finally {
    try {
      await cdp?.send('Browser.close')
    } catch {
      // 关不掉就杀
    }
    edge.kill()
  }

  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
