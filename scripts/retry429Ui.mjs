// 第二层验收的浏览器驱动：连 CDP、发一条消息、把界面变化录成时间线。
// 只管「操作与观察」，不做断言（断言在 verify-retry-429.mjs）。
import { spawn } from 'node:child_process'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class Cdp {
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

  async eval(expression, timeoutMs = 20_000) {
    const result = await Promise.race([
      this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('页面无响应')), timeoutMs)),
    ])
    if (result.exceptionDetails) throw new Error(`页面异常：${result.exceptionDetails.text}`)
    return result.result.value
  }
}

export async function waitHttp(url, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
    } catch {
      // 还没起来
    }
    await sleep(150)
  }
  throw new Error(`等待 ${url} 超时`)
}

export async function waitEval(cdp, expression, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await cdp.eval(expression).catch(() => null)
    if (value) return value
    await sleep(150)
  }
  throw new Error(`等待${label}超时`)
}

/** 起一个无头 Edge，返回子进程。 */
export function launchEdge(cdpPort, profileDir, edgePath) {
  return spawn(
    edgePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1400,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
}

/** 页面当前状态：提示条、错误条、草稿、按钮、消息计数。 */
const PAGE_STATE = `(() => {
  const notice = document.querySelector('.chat-notice-text')?.textContent || ''
  const detail = document.querySelector('.chat-notice-detail')?.textContent || ''
  const warn = document.querySelector('.chat-warn')?.textContent || ''
  const draft = document.querySelector('.chat-input')?.value || ''
  const send = document.querySelector('.chat-send')
  const running = !!document.querySelector('.chat-send.stop')
  const assistant = [...document.querySelectorAll('.chat-msg.assistant .chat-bubble')]
    .map((el) => el.textContent || '').join(' | ')
  return {
    notice, detail, warn, draft, running,
    sendText: send?.textContent || '',
    sendDisabled: send ? !!send.disabled : null,
    assistant,
    userCount: document.querySelectorAll('.chat-msg.user').length,
    assistantCount: document.querySelectorAll('.chat-msg.assistant').length,
  }
})()`

export const readPage = (cdp) => cdp.eval(PAGE_STATE)

/**
 * 打开页面、设工作区根、发一条消息，然后一直采样到「出回复」或「走到放弃」。
 * arm 由调用方在返回后立刻执行（要先武装假模型，再点发送）。
 */
export async function runUiFlow({ cdp, cdpPort, devUrl, appRoot, text, arm, onFirstRetry, doneWhen, maxWaitMs = 90_000 }) {
  const timeline = []
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.navigate', { url: `${devUrl}/` })
  await waitEval(cdp, `document.readyState === 'complete'`, 20_000, '页面加载')
  await cdp.eval(`localStorage.setItem('oc-workbench:root', ${JSON.stringify(appRoot)})`)
  await cdp.send('Page.reload', {})
  await waitEval(cdp, `document.readyState === 'complete'`, 20_000, '重新加载')
  await waitEval(
    cdp,
    `(() => { const el = document.querySelector('.chat-input'); return !!el && !el.disabled })()`,
    40_000,
    '输入框可用（后端已连接）',
  )

  // 每次运行都会清空 data 目录，实例里没有历史会话；不点「新会话」，
  // 否则会触发切会话的草稿恢复，把刚输入的内容清掉。
  const assistantCount = await cdp.eval(`document.querySelectorAll('.chat-msg.assistant').length`)
  if (assistantCount !== 0) throw new Error(`实例里有 ${assistantCount} 条旧回复，验收会串味`)

  await arm()

  // 草稿会异步从盘上恢复一次，可能把刚输入的内容覆盖掉：输入 → 等一拍 → 复核
  const typeOnce = () =>
    cdp.eval(`(() => {
      const el = document.querySelector('.chat-input')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(el, ${JSON.stringify(text)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return el.value
    })()`)
  let typed = ''
  for (let i = 0; i < 6; i += 1) {
    typed = await typeOnce()
    await sleep(250)
    const still = await cdp.eval(`document.querySelector('.chat-input')?.value || ''`).catch(() => '')
    if (typed === text && still === text) break
  }
  if (typed !== text) throw new Error(`输入框没吃进文字（拿到 ${typed}）`)

  const before = await readPage(cdp)
  if (before.draft !== text) throw new Error(`草稿被覆盖了（现在是 "${before.draft}"）`)
  timeline.push({ t: 0, event: `准备发送：draft="${before.draft}" 按钮="${before.sendText}"` })

  const clicked = await cdp.eval(
    `(() => { const b = document.querySelector('.chat-send:not(.stop)'); if (!b) return 'no-button'; if (b.disabled) return 'disabled'; b.click(); return 'ok' })()`,
  )
  if (clicked !== 'ok') throw new Error(`发送按钮不可用：${clicked}`)
  timeline.push({ t: 0, event: `点击发送「${text}」` })

  const started = Date.now()
  let lastKey = ''
  let page = null
  let idleTicks = 0
  let seenReply = false
  let seenGiveUp = false
  let retryHookRan = false

  while (Date.now() - started < maxWaitMs) {
    page = await readPage(cdp).catch(() => null)
    if (page) {
      const gotReply = page.assistant.includes('pong-429-ok')
      const gaveUp = page.notice.includes('已重试')
      seenReply = seenReply || gotReply
      seenGiveUp = seenGiveUp || gaveUp
      const key = [page.notice, page.warn, page.running, gotReply, page.userCount].join('|')
      if (key !== lastKey) {
        lastKey = key
        idleTicks = 0
        timeline.push({
          t: Date.now() - started,
          event: `提示「${page.notice}」${page.detail ? ` / ${page.detail}` : ''}${
            page.warn ? ` / 错误「${page.warn}」` : ''
          }${page.running ? '（生成中）' : ''} / 用户消息 ${page.userCount} 条${gotReply ? '，收到回复' : ''}`,
        })
      }
      // 第一次出现「正在自动重试」时，给调用方一个介入点（例如切走会话）
      if (!retryHookRan && page.notice.includes('正在自动重试') && onFirstRetry) {
        retryHookRan = true
        timeline.push({ t: Date.now() - started, event: '第一次重试已排期，执行介入动作' })
        await onFirstRetry()
        continue
      }
      if (doneWhen?.(page)) {
        await sleep(1500)
        page = await readPage(cdp).catch(() => page)
        break
      }
      if (gotReply && !page.running) {
        // 再等一会儿，覆盖「重投成功后又被删一次」的竞态
        await sleep(3000)
        page = await readPage(cdp).catch(() => page)
        break
      }
      if (gaveUp) {
        await sleep(1500)
        page = await readPage(cdp).catch(() => page)
        break
      }
    }

    // 15 秒还没有任何一次投递：消息根本没发出去，别傻等
    idleTicks += 1
    if (idleTicks >= 60 && !seenReply && !seenGiveUp) {
      timeline.push({ t: Date.now() - started, event: '15 秒内没有任何进展，提前结束诊断' })
      break
    }
    await sleep(250)
  }

  return { page: page ?? (await readPage(cdp)), timeline, seenReply, seenGiveUp }
}
