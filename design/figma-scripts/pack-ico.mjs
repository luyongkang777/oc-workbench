// 把 .tmp/icons/icon-<size>.png 打包成 shell/icon.ico（PNG 压缩条目，Vista+ 原生支持）
import fs from 'node:fs'
import path from 'node:path'

const dir = path.resolve('.tmp/icons')
const out = path.resolve('shell/icon.ico')
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]

const images = sizes.map((s) => {
  const png = fs.readFileSync(path.join(dir, `icon-${s}.png`))
  return { size: s, png }
})

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type = icon
header.writeUInt16LE(images.length, 4)

const entries = []
let offset = 6 + images.length * 16
for (const { size, png } of images) {
  const e = Buffer.alloc(16)
  e.writeUInt8(size >= 256 ? 0 : size, 0) // width
  e.writeUInt8(size >= 256 ? 0 : size, 1) // height
  e.writeUInt8(0, 2) // palette
  e.writeUInt8(0, 3) // reserved
  e.writeUInt16LE(1, 4) // planes
  e.writeUInt16LE(32, 6) // bpp
  e.writeUInt32LE(png.length, 8)
  e.writeUInt32LE(offset, 12)
  entries.push(e)
  offset += png.length
}

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, Buffer.concat([header, ...entries, ...images.map((i) => i.png)]))
console.log(`wrote ${out} (${fs.statSync(out).size} bytes, ${images.length} entries)`)

// 同时留一份主图给 README / 商店用
fs.copyFileSync(path.join(dir, 'icon-256.png'), 'design/app-icon-256.png')
console.log('copied design/app-icon-256.png')
