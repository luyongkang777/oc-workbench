// 验收：「打开失败只能干看着」→ 现在会自动在别处找到并给出可点结果。
//
// 前置：vite 已在 127.0.0.1:5273 跑着（npm run dev）。
// 用法：node scripts/verify-locate.mjs
//
// 场景（真实用户路径）：
//   工作区停在 F:\opencode\workbench，而工具详情/状态栏给的路径是
//   `demo/dev-check.mjs`（真实存在，但在工作区的**上级目录** F:\opencode 里）。
//   以前按当前根拼路径必然 404，只有一个「重试」；重试还是 404。
//
// 断言：
//   1. 查看区确实停在 404 态，且「重试」还在；
//   2. 自动列出了在上级目录里找到的候选（不是原路径回显）；
//   3. 点第一条后真的打开了，能看到文件内容；
//   4. 完全找不到的路径给出明确说明（不是一直转圈）。

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DEBUG_PORT = 9341
const APP_URL = 'http://127.0.0.1:5273/'
const OUT_DIR = path.resolve('.tmp')
const PROFILE = path.join(OUT_DIR, 'edge-locate')
// 工作区 = 本仓库根（换机器也能跑，不写死盘符）
const ROOT = path.resolve(import.meta.dirname, '..')
// 上级目录：放一个真实存在的文件，模拟「文件在工作区之外」
const PARENT = path.dirname(ROOT)

/**
 * 在工作区里不存在、但在**上级目录**里真实存在的相对路径。
 * 由 prepareSibling() 现场创建，跑完删掉，不依赖这台机器上的历史文件。
 */
const MISSING = '.oc-locate-probe/probe-target.mjs'
/** 绝对不存在的路径：用来验证「找不到」时的说明文案。 */
const NOWHERE = '.tmp/definitely-not-here-98765.mjs'

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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || '脚本执行失败')
    }
    return result.result.value
  }
}

const report = []
const check = (name, ok, detail = '') => {
  report.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

/** 把工作区与「上次打开的文件」写进 localStorage，再刷新到那个 404 态。 */
async function openMissing(cdp, missing) {
  const projects = [
    { path: ROOT, name: 'workbench', lastUsed: Date.now(), state: { file: missing, view: 'code' } },
    // 上级目录也当成「用过的项目」记着：跨作用域搜索会把它算进来
    { path: PARENT, name: path.basename(PARENT), lastUsed: Date.now() - 1000 },
  ]
  await cdp.eval(`
    localStorage.setItem('oc-workbench:root', ${JSON.stringify(ROOT)});
    localStorage.setItem('oc-workbench:projects', ${JSON.stringify(JSON.stringify(projects))});
    true
  `)
  await cdp.send('Page.navigate', { url: APP_URL })
  await sleep(2500)
}

/** 在上级目录里造一个真实文件：它就是「别处找到」的目标。 */
async function prepareSibling() {
  const target = path.join(PARENT, MISSING)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, '// locate probe\nexport const ok = 1\n')
  return target
}

function cleanupSibling() {
  rmSync(path.join(PARENT, path.dirname(MISSING)), { recursive: true, force: true })
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  prepareSibling()
  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--window-size=1500,950',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let cdp
  try {
    await waitOk(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    const targets = await (await waitOk(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page')
    if (!page) throw new Error('没有找到 page target')
    cdp = await Cdp.connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')

    // 先开一次拿到 origin，才能写 localStorage
    await cdp.send('Page.navigate', { url: APP_URL })
    await sleep(1200)

    await openMissing(cdp, MISSING)

    const ready = await cdp.eval('document.readyState')
    check('页面加载完成', ready === 'complete', ready)

    const errText = await cdp.eval(
      `document.querySelector('.editor-error')?.textContent || ''`,
    )
    check('查看区是 404 错误态', /文件不存在/.test(errText), errText.slice(0, 80))
    check('错误框里仍有「重试」', /重试/.test(errText))

    // 兜底：应该很快在上级目录里找到这个文件
    let hitCount = 0
    let waited = 0
    for (let i = 0; i < 60; i += 1) {
      hitCount = await cdp.eval(`document.querySelectorAll('.locate-item').length`)
      if (hitCount > 0) break
      waited += 200
      await sleep(200)
    }
    check('自动在其它目录里找到了候选', hitCount > 0, `${hitCount} 条，用时 ${waited}ms`)

    const items = await cdp.eval(`[...document.querySelectorAll('.locate-item')].map((el) => ({
      where: el.querySelector('.locate-where')?.textContent || '',
      path: el.querySelector('.locate-path')?.textContent || '',
      title: el.getAttribute('title') || '',
    }))`)
    process.stdout.write(`      候选：${JSON.stringify(items)}\n`)
    check(
      '候选指向真实存在的那个文件',
      items.some((item) =>
        String(item.title || '')
          .toLowerCase()
          .endsWith(path.join(MISSING).toLowerCase()),
      ),
      items.map((item) => item.title).join(' , '),
    )

    // 点第一条，必须真的打开（不再是 404，且能看到内容）
    const clicked = await cdp.eval(`(() => {
      const btn = document.querySelector('.locate-item')
      if (!btn) return null
      btn.click()
      return btn.querySelector('.locate-path')?.textContent || ''
    })()`)
    check('能点到候选条目', Boolean(clicked), clicked || '无')

    let opened = null
    for (let i = 0; i < 60; i += 1) {
      opened = await cdp.eval(`(() => {
        // 只认当前可见的标签：别的标签只是 display:none 藏起来，DOM 还在
        const slot = [...document.querySelectorAll('.editor-slot')].find(
          (el) => el.style.display !== 'none',
        )
        if (!slot) return { hasError: true, pathText: '没有可见标签', lines: 0 }
        return {
          hasError: Boolean(slot.querySelector('.editor-error')),
          pathText: slot.querySelector('.editor-path-text')?.textContent || '',
          lines: slot.querySelectorAll('.code-line').length,
        }
      })()`)
      if (!opened.hasError && opened.lines > 0) break
      await sleep(250)
    }
    check('点一下真的打开了（不再是 404）', !opened.hasError, JSON.stringify(opened).slice(0, 120))
    check('打开后能看到文件内容', opened.lines > 0, `${opened.lines} 行`)

    // 完全找不到的路径：要给明确说明，不能一直转圈
    await openMissing(cdp, NOWHERE)
    let note = ''
    for (let i = 0; i < 80; i += 1) {
      note = await cdp.eval(`document.querySelector('.locate-note')?.textContent || ''`)
      if (note && !note.includes('正在')) break
      await sleep(250)
    }
    check('找不到时给明确说明（不再只是转圈）', /没有找到|搜索时出错/.test(note), note.slice(0, 60))

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path.join(OUT_DIR, 'verify-locate.png'), Buffer.from(shot.data, 'base64'))
    process.stdout.write('      截图：.tmp/verify-locate.png\n')
  } finally {
    try {
      cdp?.ws.close()
    } catch {
      // 忽略
    }
    spawn('taskkill', ['/pid', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
    cleanupSibling()
  }

  const failed = report.filter((item) => !item.ok)
  process.stdout.write(`\n${report.length - failed.length}/${report.length} 通过\n`)
  if (failed.length > 0) {
    process.stdout.write(`失败：${failed.map((item) => item.name).join('、')}\n`)
    process.exitCode = 1
  }
}

await main()
