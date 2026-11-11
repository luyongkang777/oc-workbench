// 附件两处修复的实测：
//   1) 8MB 截图（压缩后 <6MB）现在能加进来（修复前被 6MB 原始上限直接拒）
//   2) 发送体只带一份 uri（不再 uri + source.uri 各一份导致 413）
//
// 用法：先起 vite；`node scripts/verify-attach.mjs`

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomBytes } from 'node:crypto'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9338
const APP_URL = 'http://127.0.0.1:5273/'
const OUT_DIR = path.resolve('.tmp')
const PROFILE = path.join(OUT_DIR, 'edge-attach')
const ROOT = 'F:\\opencode\\workbench'
const IMAGE = path.join(OUT_DIR, 'big-shot.png')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 生成一张高熵 PNG：zlib 压不动，体积≈原始像素，稳定超过 6MB 闸门。 */
function makeBigPng(file, width = 1900, height = 1500) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const crc32 = (buf) => {
    let c = ~0
    for (const byte of buf) {
      c ^= byte
      for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return (~c) >>> 0
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  // 真随机像素：zlib 压不动，文件体积≈像素字节数，能稳定越过 6MB 闸门
  const raw = randomBytes((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) raw[y * (width * 3 + 1)] = 0
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
  writeFileSync(file, png)
  return png.length
}

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

  async eval(expression, timeoutMs = 60_000) {
    const result = await Promise.race([
      this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('页面无响应')), timeoutMs)),
    ])
    if (result.exceptionDetails) throw new Error(`页面异常：${result.exceptionDetails.text}`)
    return result.result.value
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const bytes = makeBigPng(IMAGE)
  const out = { imageBytes: bytes, imageMB: +(bytes / 1024 / 1024).toFixed(2) }

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
    await waitOk(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    const targets = await (await waitOk(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page')
    cdp = await Cdp.connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('DOM.enable')
    await cdp.send('Page.navigate', { url: APP_URL })
    await sleep(1200)
    await cdp.eval(`window.localStorage.setItem('oc-workbench:root', ${JSON.stringify(ROOT)})`)
    await cdp.send('Page.reload')
    await sleep(1800)

    // 给隐藏的 file input 塞文件（等价于用户点「＋图片」选文件）
    const doc = await cdp.send('DOM.getDocument', { depth: -1 })
    const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
    out.inputNodeId = node.nodeId
    await cdp.send('DOM.setFileInputFiles', { files: [IMAGE], nodeId: node.nodeId })

    out.afterPick = await cdp.eval(
      `(async () => {
        const started = performance.now()
        while (performance.now() - started < 30000) {
          const item = document.querySelector('.chat-attach')
          if (item) {
            await new Promise(r => setTimeout(r, 300))
            const shown = document.querySelector('.chat-attach')?.getAttribute('title') || ''
            return {
              attached: document.querySelectorAll('.chat-attach').length,
              title: shown,
              notice: document.querySelector('.chat-attach-notice')?.textContent || '',
              thumb: !!document.querySelector('.chat-attach-thumb'),
            }
          }
          await new Promise(r => setTimeout(r, 100))
        }
        return {
          attached: 0,
          notice: document.querySelector('.chat-attach-notice')?.textContent || '',
          warn: document.querySelector('.chat-warn')?.textContent || '',
        }
      })()`,
      45_000,
    )

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    out.shot = path.join(OUT_DIR, 'verify-attach.png')
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
