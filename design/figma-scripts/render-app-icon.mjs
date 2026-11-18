// 连已运行的 Edge（--remote-debugging-port=9344）批量渲染图标尺寸
import fs from 'node:fs'
import path from 'node:path'

const OUT = path.resolve('.tmp/icons')
fs.mkdirSync(OUT, { recursive: true })
const PORT = 9344
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function hexPath(cx, cy, r) {
  const pts = []
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI / 180) * (60 * i - 90)
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`)
  }
  return `M${pts.join(' L')} Z`
}

function mark(small) {
  const scale = small ? 1.16 : 1
  const hex = hexPath(256, 256, 150 * scale)
  const body = small
    ? `<path d="${hex}" fill="#38bdf8"/>`
    : `<path d="${hex}" fill="#0e2b3d"/><path d="${hex}" fill="none" stroke="#38bdf8" stroke-width="20" stroke-linejoin="round"/>`
  const glyph = small
    ? `<path d="M204 212 L248 256 L204 300" fill="none" stroke="#0b1216" stroke-width="36" stroke-linecap="square"/>
       <path d="M266 300 H320" fill="none" stroke="#0b1216" stroke-width="36"/>`
    : `<path d="M206 214 L248 256 L206 298" fill="none" stroke="#38bdf8" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
       <path d="M268 298 H318" fill="none" stroke="#38bdf8" stroke-width="26" stroke-linecap="round"/>`
  return `${body}${glyph}`
}

const page = (small) => `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>
<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 512 512">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
    <stop offset="0" stop-color="#1a1d24"/><stop offset="1" stop-color="#0a0b0e"/></linearGradient></defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <rect x="2" y="2" width="508" height="508" rx="110" fill="none" stroke="#ffffff" stroke-opacity="${small ? 0.12 : 0.07}" stroke-width="4"/>
  ${mark(small)}
</svg>`

let targets = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'page')
if (targets.length === 0) {
  await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
  await wait(800)
  targets = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'page')
}
if (targets.length === 0) throw new Error('no page target')
const target = targets[0]

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')) })
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
const send = (method, params = {}) => new Promise((resolve) => {
  const mid = ++id
  pending.set(mid, resolve)
  ws.send(JSON.stringify({ id: mid, method, params }))
})

await send('Page.enable')
for (const size of [16, 20, 24, 32, 40, 48, 64, 128, 256]) {
  const htmlPath = path.join(OUT, `icon-${size}.html`)
  fs.writeFileSync(htmlPath, page(size <= 40), 'utf8')
  await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `file:///${htmlPath.replace(/\\/g, '/')}` })
  await wait(700)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (!shot.result?.data) throw new Error(`capture failed at ${size}`)
  const png = path.join(OUT, `icon-${size}.png`)
  fs.writeFileSync(png, Buffer.from(shot.result.data, 'base64'))
  console.log('rendered', size, fs.statSync(png).size + 'B')
}
ws.close()
process.exit(0)
