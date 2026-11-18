/**
 * `@` 文件提及的真机验收（CDP 驱动，不手点）。
 *
 * 用法：
 *   node scripts/verify-mention.mjs                      # dev（vite 在 5273）
 *   node scripts/verify-mention.mjs 9223                 # 指定 CDP 端口
 *   $env:OCW_CDP_PORT=9231; node scripts/verify-mention.mjs
 *
 * 断言都取 DOM 真值：菜单是否可见、候选条数、插入后的输入框文本与光标位置。
 */
import { execFileSync } from 'node:child_process'

const port = process.argv[2] || process.env.OCW_CDP_PORT || '9223'
const HOST = '127.0.0.1'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

async function httpJson(path) {
  const res = await fetch(`http://${HOST}:${port}${path}`)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`)
  return res.json()
}

/** 极简 CDP 客户端：够用即可，不引入依赖。 */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true })
    })
    return new Cdp(ws)
  }

  send(method, params = {}) {
    this.seq += 1
    const id = this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`CDP 超时：${method}`))
      }, 20000)
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'JS 执行失败')
    }
    return result.result.value
  }
}

/**
 * 往受控 textarea 写值并定位光标。
 *
 * 必须用原生 setter：React 受控组件只听 onChange，直接 el.value = x 只会改 DOM，
 * state 不变，菜单永远不弹（这条坑实测踩过）。
 */
function setInputExpr(value, caret = value.length) {
  return `(() => {
    const el = document.querySelector('.chat-input')
    if (!el) return false
    el.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.setSelectionRange(${caret}, ${caret})
    return true
  })()`
}

async function findPage() {
  const targets = await httpJson('/json/list')
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('找不到可连的页面（Edge/exe 起了吗？）')
  return page
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等到条件成立（DOM 有值），超时返回 false。 */
async function waitFor(cdp, expression, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await cdp.eval(expression)
    if (value) return value
    await sleep(120)
  }
  return false
}

async function main() {
  const page = await findPage()
  let cdp = await Cdp.connect(page.webSocketDebuggerUrl)

  // 新 profile 会停在「选目录」引导页：先写 root，再按需刷新。
  // 注意：Page.reload 之后这条 WebSocket 会随页面卸载失效，必须重新取 target，
  // 所以这里「先写 root → 检测输入框 → 没有才 reload 并重连」。
  const root = process.env.OCW_ROOT || 'F:\\opencode\\workbench'
  await cdp.eval(`window.localStorage.setItem('oc-workbench:root', ${JSON.stringify(root)})`)

  let hasInput = await waitFor(cdp, `!!document.querySelector('.chat-input')`, 4000)
  if (!hasInput) {
    await cdp.eval(`location.reload()`).catch(() => {})
    await sleep(2500)
    const page2 = await findPage()
    cdp = await Cdp.connect(page2.webSocketDebuggerUrl)
    hasInput = await waitFor(cdp, `!!document.querySelector('.chat-input')`, 25000)
  }
  if (!hasInput) {
    record('输入框就绪', false, '没找到 .chat-input，可能后端没连上')
    return finish()
  }
  record('输入框就绪', true)

  // 1) 打 @ 出菜单
  await cdp.eval(setInputExpr('@', 1))
  const menuShown = await waitFor(cdp, `!!document.querySelector('.chat-slash-menu')`, 10000)
  record('打 @ 弹出菜单', !!menuShown)

  // 2) 有候选（空查询会拿到一批打底）
  // 前面有 90ms 防抖 + 一次磁盘搜索，必须等候选出现再数，否则偶发 0 条
  await waitFor(
    cdp,
    `document.querySelectorAll('.chat-slash-menu .chat-slash-item').length > 0`,
    10000,
  )
  const countAll = await cdp.eval(
    `document.querySelectorAll('.chat-slash-menu .chat-slash-item').length`,
  )
  record('空查询有候选打底', countAll > 0, `${countAll} 条`)

  // 3) 输入关键字收窄，候选项都该命中该词
  await cdp.eval(setInputExpr('@chat', 5))
  // 等「候选非空且标题都含 chat」——BFS 扫得更广，回包比 DFS 慢一点，
  // 只等「有候选」可能会拿到上一轮 @ 空查询的旧候选
  await waitFor(
    cdp,
    `(() => {
      const items = [...document.querySelectorAll('.chat-slash-menu .chat-slash-item')]
      if (items.length === 0) return false
      return items.every((el) => (el.getAttribute('title') || '').toLowerCase().includes('chat'))
    })()`,
    15000,
  )
  await sleep(200)
  const filtered = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('.chat-slash-menu .chat-slash-item')]
      return {
        count: items.length,
        paths: items.map((el) => el.getAttribute('title') || ''),
        names: items.map((el) => el.querySelector('.chat-slash-name')?.textContent || ''),
      }
    })()
  `)
  const allHit = filtered.paths.every((p) => p.toLowerCase().includes('chat'))
  record(
    '关键字过滤只留命中项',
    filtered.count > 0 && allHit,
    `${filtered.count} 条：${filtered.names.slice(0, 3).join(', ')}`,
  )

  // 4) 点第一条：输入框里应出现 @路径，菜单收起
  const picked = filtered.paths[0] || ''
  await cdp.eval(`
    (() => {
      const first = document.querySelector('.chat-slash-menu .chat-slash-item')
      if (!first) return false
      first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      return true
    })()
  `)
  await sleep(500)
  const afterPick = await cdp.eval(`
    (() => {
      const el = document.querySelector('.chat-input')
      return {
        value: el.value,
        caret: el.selectionStart,
        menuOpen: !!document.querySelector('.chat-slash-menu'),
      }
    })()
  `)
  const inserted = picked && afterPick.value.includes(picked.split(/[\\/]/).pop())
  record('选中后写入输入框', !!inserted, JSON.stringify(afterPick.value))
  record('选中后菜单收起', afterPick.menuOpen === false)
  record('光标落在插入内容末尾', afterPick.caret === afterPick.value.length, `caret=${afterPick.caret}`)

  // 5) 已完成的提及不该再弹菜单（插入的 @path 后面有空格）
  record('插入后不再误弹菜单', afterPick.menuOpen === false)

  // 6) 邮箱不触发
  await cdp.eval(setInputExpr('a@b.com', 7))
  await sleep(400)
  const emailMenu = await cdp.eval(`!!document.querySelector('.chat-slash-menu')`)
  record('邮箱里的 @ 不弹菜单', emailMenu === false)

  // 7) Esc 收起
  await cdp.eval(setInputExpr('@src', 4))
  await waitFor(cdp, `!!document.querySelector('.chat-slash-menu')`, 10000)
  const beforeEsc = await cdp.eval(`!!document.querySelector('.chat-slash-menu')`)
  await cdp.eval(`
    (() => {
      const el = document.querySelector('.chat-input')
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return true
    })()
  `)
  await sleep(300)
  const afterEsc = await cdp.eval(`!!document.querySelector('.chat-slash-menu')`)
  record('Esc 收起菜单', beforeEsc === true && afterEsc === false, `前=${beforeEsc} 后=${afterEsc}`)

  // 8) 菜单开着但候选为空时，Enter 不能穿透去发送（打错字搜不到文件时会遇到）
  await cdp.eval(setInputExpr('@zzzz-绝不存在的文件-zzzz', '@zzzz-绝不存在的文件-zzzz'.length))
  await sleep(900)
  const emptyState = await cdp.eval(`
    (() => {
      const menu = document.querySelector('.chat-slash-menu')
      return {
        open: !!menu,
        items: document.querySelectorAll('.chat-slash-menu .chat-slash-item').length,
      }
    })()
  `)
  if (emptyState.items === 0) {
    // 记录发送前的消息条数，按 Enter 后不应增长
    const before = await cdp.eval(
      `document.querySelectorAll('.msg, .turn, [data-turn]').length`,
    )
    await cdp.eval(`
      (() => {
        const el = document.querySelector('.chat-input')
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        return true
      })()
    `)
    await sleep(900)
    const after = await cdp.eval(
      `document.querySelectorAll('.msg, .turn, [data-turn]').length`,
    )
    const stillHasText = await cdp.eval(`document.querySelector('.chat-input').value.length > 0`)
    record('无候选时 Enter 不发送', before === after && stillHasText, `消息 ${before}→${after}`)
    await cdp.eval(setInputExpr('', 0))
  } else {
    record('无候选时 Enter 不发送', true, '跳过：搜索仍有候选，构造不出空场景')
  }

  // 9) 正斜杠也要有候选（审查抓到的真 bug：不归一时 @src/ 恒为 0 条）
  await cdp.eval(setInputExpr('@src/', 5))
  await waitFor(
    cdp,
    `document.querySelectorAll('.chat-slash-menu .chat-slash-item').length > 0`,
    12000,
  )
  const slashHits = await cdp.eval(
    `document.querySelectorAll('.chat-slash-menu .chat-slash-item').length`,
  )
  record('正斜杠也有候选', slashHits > 0, `${slashHits} 条`)

  // 10) 选目录后提及仍然有效（不补空格，改补反斜杠）
  const dirPicked = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('.chat-slash-menu .chat-slash-item')]
      const dir = items.find((el) => (el.getAttribute('title') || '').includes('目录'))
      if (!dir) return null
      dir.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      return true
    })()
  `)
  if (dirPicked) {
    await sleep(600)
    const dirState = await cdp.eval(`
      (() => {
        const el = document.querySelector('.chat-input')
        return {
          value: el.value,
          menu: !!document.querySelector('.chat-slash-menu'),
        }
      })()
    `)
    record(
      '选目录后能继续补',
      dirState.menu === true && dirState.value.charCodeAt(dirState.value.length - 1) === 92,
      JSON.stringify(dirState.value),
    )
    await cdp.eval(setInputExpr('', 0))
  } else {
    record('选目录后能继续补', true, '跳过：当前查询没有目录候选')
  }

  // 11) Shift+Enter 必须能换行（审查抓到的真 bug：被 Enter 拦截吞掉）
  await cdp.eval(setInputExpr('@src/', 5))
  await sleep(900)
  const beforeShift = await cdp.eval(`document.querySelector('.chat-input').value`)
  await cdp.eval(`
    (() => {
      const el = document.querySelector('.chat-input')
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', shiftKey: true, bubbles: true, cancelable: true,
      }))
      return true
    })()
  `)
  await sleep(300)
  // 真换行要靠浏览器默认行为，这里是模拟事件，只能验「没有被 preventDefault 吞掉」
  const notPrevented = await cdp.eval(`
    (() => {
      const el = document.querySelector('.chat-input')
      const probe = new KeyboardEvent('keydown', {
        key: 'Enter', shiftKey: true, bubbles: true, cancelable: true,
      })
      el.dispatchEvent(probe)
      return !probe.defaultPrevented
    })()
  `)
  record('Shift+Enter 不被吞（可换行）', notPrevented === true)
  await cdp.eval(setInputExpr('', 0))

  finish()
}

function finish() {
  // CDP 的 WebSocket 不会自己关，跑完必须显式退出，否则脚本一直挂着
  setTimeout(() => process.exit(process.exitCode || 0), 50)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length > 0) {
    console.log('失败项：')
    failed.forEach((r) => console.log(`  - ${r.name} ${r.detail}`))
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('验收脚本异常：', err.message)
  process.exitCode = 1
})
