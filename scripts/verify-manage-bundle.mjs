// 静态断言：新面板确实打进了 dist 和 exe（exe 里嵌的就是 dist）。
// 用法：node scripts/verify-manage-bundle.mjs
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const MARKS = [
  'manage-dialog', // 面板根节点类名
  'manage-search-input', // 技能搜索框
  '/api/skill', // 技能清单接口
  '/api/experimental/mcp', // MCP 运行时连接/断开
  '插入到对话', // 技能详情里的操作
  '读取技能列表超时', // 接口层错误文案
]

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

let allOk = true

const assetsDir = path.resolve('dist/assets')
const js = readdirSync(assetsDir).filter((file) => /^index-.*\.js$/.test(file))
if (js.length !== 1) {
  console.log(`FAIL  dist 里的入口 js 应该恰好一个，实际 ${js.length}`)
  process.exit(1)
}
const jsPath = path.join(assetsDir, js[0])
const bundle = readFileSync(jsPath, 'utf8')
allOk &&= check('dist 入口 js 存在', true, js[0])

for (const mark of MARKS) {
  allOk &&= check(`dist 含「${mark}」`, bundle.includes(mark))
}

const exe = path.resolve('shell/target/release/oc-workbench-shell.exe')
const exeBytes = readFileSync(exe)
// 按 UTF-8 字节比对：中文用 latin1 读出来是对不上的
const inExe = (mark) => exeBytes.includes(Buffer.from(mark, 'utf8'))
allOk &&= check('exe 存在', true, `${(exeBytes.length / 1024 / 1024).toFixed(2)} MB`)
allOk &&= check('exe 内嵌本次入口 js', inExe(js[0]), js[0])
for (const mark of MARKS) {
  allOk &&= check(`exe 含「${mark}」`, inExe(mark))
}

process.exit(allOk ? 0 : 1)
