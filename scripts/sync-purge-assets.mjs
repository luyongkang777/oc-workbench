// 把用户目录里正在用的破甲插件同步成「随 exe 发布」的内嵌资源。
//
// 为什么需要这一步：exe 能内嵌的只有构建机上的文件（include_dir! 编译期读取），
// 而插件的实际维护点在 %USERPROFILE%\.config\opencode\plugins\purge。
// 所以发布前跑一次本脚本，把那份复制进 shell/assets/purge，再由 exe 内嵌。
//
// 用法：
//   node scripts/sync-purge-assets.mjs          # 从默认位置同步
//   node scripts/sync-purge-assets.mjs --src <目录>
//
// 排除：.bak-* 备份、.git、node_modules、state/log（运行期产物）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const argi = process.argv.indexOf('--src')
const src = argi > 0 ? process.argv[argi + 1] : path.join(os.homedir(), '.config/opencode/plugins/purge')
// fileURLToPath 而不是 url.pathname：路径里有中文或空格时 pathname 是百分号编码的。
const here = path.dirname(fileURLToPath(import.meta.url))
const dest = path.resolve(here, '../shell/assets/purge')

if (!fs.existsSync(path.join(src, 'index.ts'))) {
  console.error(`[sync-purge] 源目录里没有 index.ts，拒绝同步：${src}`)
  process.exit(1)
}

const SKIP = /(^|[\\/])(\.git|node_modules)([\\/]|$)|\.bak-|(^|[\\/])(state|purge)\.log$/
const files = []
function walk(dir, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (SKIP.test(relPath)) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, relPath)
    else if (entry.isFile()) files.push(relPath)
  }
}
walk(src)

fs.rmSync(dest, { recursive: true, force: true })
for (const rel of files) {
  const target = path.join(dest, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(path.join(src, rel), target)
}

const bytes = files.reduce((n, rel) => n + fs.statSync(path.join(dest, rel)).size, 0)
console.log(`[sync-purge] ${files.length} 个文件，${(bytes / 1024).toFixed(1)} KB`)
console.log(`[sync-purge] ${src}\n         -> ${dest}`)
for (const rel of files) console.log(`  ${rel}`)
