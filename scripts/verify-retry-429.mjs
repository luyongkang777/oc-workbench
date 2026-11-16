// 第二层验收：模型调用遇到 429 时，工作台要自动重投。
//
// 验的是 Chat.tsx 里 `useChatAutoRetry` 那条链路：服务端把模型调用失败写成
// `idle/outcome=failed`，工作台按同一个 message id 重发，第二次成功。
// 关键前提（opencode 2.3 实测）：同 id 重投不会重新调度模型，必须先
// `revert/stage + revert/commit` 删掉失败那一轮；脚本要同时验证这件事真的发生了。
//
// 环境全离线、不碰用户的 opencode.json 和在跑的服务：
//   mock 假模型（28100）→ 独立 opencode（28123，XDG 目录全在 .tmp）
//   → 补 Basic 认证的代理（28150，顺带记录 /prompt 与 /revert 请求）
//   → 第二个 vite dev（5274，OC_WORKBENCH_TARGET 指代理）→ 无头 Edge（9241）
//
// 用法：
//   node scripts/verify-retry-429.mjs              失败 1 次 → 重投 1 次 → 成功
//   node scripts/verify-retry-429.mjs --fail=2     连续失败 2 次
//   node scripts/verify-retry-429.mjs --fail=6 --expect=giveup   到上限放弃
//   node scripts/verify-retry-429.mjs --delay=3000 成功响应延迟 3 秒（压竞态）
// 产物：.tmp/retry-429/report.json + retry-429.png + *.log
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { buildChecks } from './retry429Checks.mjs'
import { createAuthProxy, createMockModel } from './retry429Services.mjs'
import { Cdp, launchEdge, runUiFlow, waitHttp } from './retry429Ui.mjs'

const ROOT = process.cwd()
const WORK = path.join(ROOT, '.tmp', 'retry-429')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const PORTS = { mock: 28100, opencode: 28123, proxy: 28150, dev: 5274, cdp: 9241 }
const MOCK = `http://127.0.0.1:${PORTS.mock}`
const PROXY = `http://127.0.0.1:${PORTS.proxy}`
const DEV = `http://127.0.0.1:${PORTS.dev}`
const APP_ROOT = ROOT

const arg = (name, fallback) => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const FAIL_TIMES = Math.max(1, Number(arg('fail', '1')))
/** success：最后要成功；giveup：应该重试到上限后停下 */
const EXPECT = arg('expect', 'success')
/** 成功响应延迟（毫秒）：压「重投成功后又被删一次」的竞态 */
const DELAY_MS = Math.max(0, Number(arg('delay', '0')))
/** 故障注入：重投那次 /prompt 直接失败几次 */
const FAIL_PROMPT = Math.max(0, Number(arg('fail-prompt', '0')))
/** 故障注入：revert/stage 转发延迟（毫秒），用来制造「stage 在飞时切走」 */
const STAGE_DELAY = Math.max(0, Number(arg('stage-delay', '0')))
/** 最多重试几次（与 retryPolicy 默认值一致） */
const MAX_RETRIES = 5

const children = []
const killTree = (pid) => {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // 已经退了
  }
}
const killAll = () => {
  for (const child of children.reverse()) if (child?.pid) killTree(child.pid)
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

function pipeLog(child, name) {
  const stream = createWriteStream(path.join(WORK, `${name}.log`), { flags: 'w' })
  child.stdout?.pipe(stream)
  child.stderr?.pipe(stream)
}

/** 独立 opencode 实例：配置与数据全在 .tmp，从日志里取 server password。 */
async function startOpencode() {
  const cfg = path.join(WORK, 'cfg', 'opencode')
  const data = path.join(WORK, 'data')
  const state = path.join(WORK, 'state')
  mkdirSync(cfg, { recursive: true })
  mkdirSync(data, { recursive: true })
  mkdirSync(state, { recursive: true })
  writeFileSync(
    path.join(cfg, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model: 'mock429/mock-429',
        provider: {
          mock429: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Mock 429',
            options: { baseURL: `${MOCK}/v1`, apiKey: 'mock-key' },
            models: { 'mock-429': { name: 'Mock 429' } },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  )

  const child = spawn(
    'cmd.exe',
    ['/c', 'opencode', 'serve', '--port', String(PORTS.opencode), '--print-logs', '--log-level', 'info'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: path.join(WORK, 'cfg'),
        XDG_DATA_HOME: data,
        XDG_STATE_HOME: state,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)

  const serveLog = createWriteStream(path.join(WORK, 'opencode.log'), { flags: 'w' })
  child.stdout.on('data', (chunk) => serveLog.write(chunk))
  child.stderr.on('data', (chunk) => serveLog.write(chunk))

  const password = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`opencode 启动超时：${buffer.slice(-400)}`)), 25_000)
    const onData = (chunk) => {
      buffer += String(chunk)
      const match = /server password ([^\s]+)/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`opencode 提前退出（${code}）：${buffer.slice(-400)}`))
    })
  })

  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  const res = await fetch(`http://127.0.0.1:${PORTS.opencode}/api/info`, { headers: { authorization: auth } })
  if (!res.ok) throw new Error(`独立 opencode 不可用：${res.status}`)
  return password
}

async function startDev() {
  const child = spawn('cmd.exe', ['/c', 'npm.cmd', 'run', 'dev', '--', '--port', String(PORTS.dev), '--strictPort'], {
    cwd: ROOT,
    env: { ...process.env, OC_WORKBENCH_TARGET: PROXY },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  pipeLog(child, 'dev')
  await waitHttp(`${DEV}/`, 40_000)
}

const getJson = async (url) => (await fetch(url)).json()

async function main() {
  for (const dir of ['data', 'state', 'cfg', 'edge']) rmSync(path.join(WORK, dir), { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })

  const { server: mockServer } = createMockModel(PORTS.mock)
  await listen(mockServer, PORTS.mock)
  const password = await startOpencode()
  const { server: proxyServer } = createAuthProxy(PORTS.proxy, PORTS.opencode, password)
  await listen(proxyServer, PORTS.proxy)
  await startDev()

  const edge = launchEdge(PORTS.cdp, path.join(WORK, 'edge'), EDGE)
  children.push(edge)

  const text = `ping-429-${Date.now().toString(36)}`
  let cdp = null
  try {
    await waitHttp(`http://127.0.0.1:${PORTS.cdp}/json/version`, 25_000)
    const targets = await (await waitHttp(`http://127.0.0.1:${PORTS.cdp}/json/list`)).json()
    cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)

    const result = await runUiFlow({
      cdp,
      cdpPort: PORTS.cdp,
      devUrl: DEV,
      appRoot: APP_ROOT,
      text,
      arm: async () => {
        await fetch(`${MOCK}/__arm?fail=${FAIL_TIMES}&code=429&noretry=1&delay=${DELAY_MS}`)
        await fetch(`${PROXY}/__arm?promptFail=${FAIL_PROMPT}&stageDelay=${STAGE_DELAY}`)
      },
      // 取消场景：重试刚排上就切走会话，验证不会偷偷去 commit 删消息
      onFirstRetry:
        EXPECT === 'cancel'
          ? async () => {
              await cdp.eval(`(() => { document.querySelector('.chat-new')?.click(); return true })()`)
              await new Promise((resolve) => setTimeout(resolve, 2500))
            }
          : EXPECT === 'midstage'
            ? async () => {
                // 等 timer 触发、stage 已经发出但还没返回的那个窗口再切走
                await new Promise((resolve) => setTimeout(resolve, 900))
                await cdp.eval(`(() => { document.querySelector('.chat-new')?.click(); return true })()`)
                await new Promise((resolve) => setTimeout(resolve, 2500))
              }
            : EXPECT === 'restore'
              ? async () => {
                  // 模拟用户已经在输入框里打字：原文回填必须追加，不能丢
                  await cdp.eval(`(() => {
                    const el = document.querySelector('.chat-input')
                    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
                    setter.call(el, 'draft-keep')
                    el.dispatchEvent(new Event('input', { bubbles: true }))
                    return true
                  })()`)
                }
              : undefined,
      doneWhen:
        EXPECT === 'restore' || EXPECT === 'midstage'
          ? (p) => (p.detail || '').includes('重投没有成功')
          : undefined,
    })

    const mock = await getJson(`${MOCK}/__stats`)
    const proxy = await getJson(`${PROXY}/__stats`)
    const main = (mock.calls ?? []).filter((c) => c.kind === 'main')
    const sent = proxy.prompts ?? []
    const reverts = proxy.reverts ?? []
    const stages = reverts.filter((item) => item.action === 'stage')
    const commits = reverts.filter((item) => item.action === 'commit')
    const checks = buildChecks({
      expect: EXPECT,
      failTimes: FAIL_TIMES,
      maxRetries: MAX_RETRIES,
      main,
      sent,
      stages,
      commits,
      page: result.page,
      timeline: result.timeline,
      text,
    })

    console.log(`\n=== 第二层验收：429 自动重投（fail=${FAIL_TIMES} expect=${EXPECT} delay=${DELAY_MS}ms）===`)
    for (const item of result.timeline) console.log(`  +${String(item.t).padStart(6)}ms  ${item.event}`)
    console.log('\n  检查项：')
    let failed = 0
    for (const [name, ok, extra] of checks) {
      if (!ok) failed += 1
      console.log(`   ${ok ? '✅' : '❌'} ${name}${extra ? `（${extra}）` : ''}`)
    }

    writeFileSync(
      path.join(WORK, 'report.json'),
      JSON.stringify({ ok: failed === 0, params: { FAIL_TIMES, EXPECT, DELAY_MS }, timeline: result.timeline, checks, page: result.page, mock, proxy }, null, 2),
      'utf8',
    )
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(path.join(WORK, 'retry-429.png'), Buffer.from(shot.data, 'base64'))
    } catch {
      // 截图失败不影响结论
    }

    if (failed > 0) {
      console.log(`\n❌ 第二层验收未通过（${failed} 项）`)
      process.exitCode = 1
    } else {
      const banner = {
        giveup: '失败到上限后停下，不无限重试',
        cancel: '重试排期后切走会话，不会偷偷回撤删消息',
        midstage: 'stage 在飞时切走，不会接着 commit 删消息',
        restore: '回撤后投递失败，原文完整回填输入框',
      }
      console.log(`\n✅ 第二层验收通过：${banner[EXPECT] ?? '429 失败后自动回撤重投，第二次成功'}`)
    }
  } finally {
    try {
      await cdp?.send('Browser.close')
    } catch {
      // 关不掉就杀
    }
    killAll()
    mockServer.close()
    proxyServer.close()
  }
}

main().catch((err) => {
  console.error(`\n❌ 验收脚本出错：${err.message}`)
  killAll()
  process.exit(1)
})
