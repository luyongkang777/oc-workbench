/**
 * 多模型路由端到端验收（直接打 opencode API，不经过工作台界面）。
 *
 * 验证的是「配置能被 opencode 认、主脑真的会派执行体和审核体、产物真的落地」：
 *   1. 写三个 router-*.md 到 <root>/.opencode/agents/
 *   2. 建会话并切到 router-main
 *   3. 发一个「建文件 + 自检」的任务
 *   4. 等父会话空闲、所有子会话结束
 *   5. 断言：出现 router-worker、出现 router-reviewer、目标文件内容正确
 *
 * 会真实调用模型（有耗时和费用），也会临时改写 `.opencode/agents/router-*.md`；
 * 脚本开始前备份、结束时还原，不会覆盖用户已有配置。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-router-e2e.mjs
 *   $env:OCW_ROUTER_ROOT='F:\some\project'; node --experimental-strip-types scripts/verify-router-e2e.mjs
 *
 * 模型想换就改下面的 MODELS：主脑建议用强模型，执行体/审核体用便宜且不同的两个。
 */

import fs from 'node:fs'
import path from 'node:path'

import { buildRouterAgents } from '../src/components/routerConfig.ts'

const ROOT = path.resolve(process.env.OCW_ROUTER_ROOT || '.')
const AGENT_DIR = path.join(ROOT, '.opencode', 'agents')
const NAMES = ['router-main', 'router-worker', 'router-reviewer']
const TARGET = path.join(ROOT, '.tmp', 'router-e2e.txt')
const TIMEOUT_MS = Number(process.env.OCW_ROUTER_TIMEOUT || 360_000)

const MODELS = {
  main: { providerID: 'command-code', id: 'google/gemini-3.8-flash' },
  worker: { providerID: 'deepseek-official', id: 'deepseek-flash' },
  reviewer: { providerID: 'command-code', id: 'deepseek/deepseek-v4.1-flash' },
}

function serviceInfo() {
  const file = path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'),
    '..',
    'state',
    'opencode',
    'service.json',
  )
  const fallback = path.join(process.env.USERPROFILE || '.', '.local', 'state', 'opencode', 'service.json')
  const target = fs.existsSync(file) ? file : fallback
  if (!fs.existsSync(target)) throw new Error(`找不到 opencode service.json：${target}`)
  return JSON.parse(fs.readFileSync(target, 'utf8'))
}

const service = serviceInfo()
const BASE = service.url
const AUTH = {
  authorization: `Basic ${Buffer.from('opencode:' + service.password).toString('base64')}`,
  'content-type': 'application/json',
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: AUTH,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

const unwrap = (payload) => payload?.data ?? payload
const isBusy = (item) => (item?.time?.busy ?? 0) > (item?.time?.idle ?? 0)

const backup = new Map()
for (const name of NAMES) {
  const file = path.join(AGENT_DIR, `${name}.md`)
  if (fs.existsSync(file)) backup.set(name, fs.readFileSync(file, 'utf8'))
}

function restore() {
  for (const name of NAMES) {
    const file = path.join(AGENT_DIR, `${name}.md`)
    if (backup.has(name)) fs.writeFileSync(file, backup.get(name), 'utf8')
    else if (fs.existsSync(file)) fs.rmSync(file, { force: true })
  }
  if (fs.existsSync(TARGET)) fs.rmSync(TARGET, { force: true })
}

async function main() {
  fs.mkdirSync(AGENT_DIR, { recursive: true })
  if (fs.existsSync(TARGET)) fs.rmSync(TARGET, { force: true })
  for (const file of buildRouterAgents(MODELS)) {
    fs.writeFileSync(path.join(AGENT_DIR, `${file.name}.md`), file.content, 'utf8')
  }
  await sleep(1000)

  const agents = unwrap(
    await api('GET', `/api/agent?location%5Bdirectory%5D=${encodeURIComponent(ROOT)}`),
  )
  const ids = (Array.isArray(agents) ? agents : []).map((item) => item.id)
  const visible = ids.filter((id) => id.startsWith('router-'))
  console.log('agents:', visible.join(', ') || '(none)')
  if (visible.length !== 3) throw new Error('服务端没认全三个 router agent')

  const created = unwrap(
    await api('POST', '/api/session', {
      location: { directory: ROOT },
      metadata: { source: 'oc-workbench' },
      title: 'router e2e',
    }),
  )
  const sessionID = created.id
  console.log('session:', sessionID)

  await api('POST', `/api/session/${sessionID}/agent`, { agent: 'router-main' })
  await api('POST', `/api/session/${sessionID}/prompt`, {
    text: [
      '在项目根目录创建文件 .tmp/router-e2e.txt，内容写 router-ok（一行）。',
      '按你的流程：先列验收标准，派 router-worker 执行，再派 router-reviewer 判定，最后总结。',
      '必须派子代理，不要自己创建文件。',
    ].join(''),
  })
  console.log('prompt sent, waiting...')

  const started = Date.now()
  let session = null
  let children = []
  let idleSince = null
  let lastLog = ''
  while (Date.now() - started < TIMEOUT_MS) {
    session = unwrap(await api('GET', `/api/session/${sessionID}`))
    children = unwrap(await api('GET', `/api/session?parentID=${sessionID}&limit=50`)) || []
    const rows = Array.isArray(children) ? children : []
    const frozen = !isBusy(session) && rows.every((row) => !isBusy(row))
    const log = rows
      .map((row) => `${row.agent ?? '?'}:${isBusy(row) ? 'run' : row.outcome ?? 'idle'}`)
      .join(',')
    if (log !== lastLog) {
      console.log(
        `[${Math.round((Date.now() - started) / 1000)}s] parent=${
          isBusy(session) ? 'run' : session?.outcome ?? 'idle'
        } children=${log || '(none)'}`,
      )
      lastLog = log
    }
    if (frozen) {
      if (idleSince === null) idleSince = Date.now()
      if (Date.now() - idleSince > 8000) break
    } else {
      idleSince = null
    }
    await sleep(3000)
  }

  const rows = Array.isArray(children) ? children : []
  const hasWorker = rows.some((row) => row.agent === 'router-worker')
  const hasReviewer = rows.some((row) => row.agent === 'router-reviewer')
  const fileOk = fs.existsSync(TARGET) && fs.readFileSync(TARGET, 'utf8').trim() === 'router-ok'

  console.log('\nRESULT')
  console.log('  worker spawned  :', hasWorker)
  console.log('  reviewer spawned:', hasReviewer)
  console.log('  target file ok  :', fileOk)

  for (const row of rows) {
    const messages = unwrap(await api('GET', `/api/session/${row.id}/message?limit=4`)) || []
    const text = [...(Array.isArray(messages) ? messages : [])]
      .reverse()
      .flatMap((m) => m.content || [])
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text)
      .join('\n')
    console.log(`\n--- ${row.agent} (${row.outcome}) ---\n${text.slice(0, 900)}`)
  }

  return hasWorker && hasReviewer && fileOk
}

let ok = false
try {
  ok = await main()
} catch (error) {
  console.error('FAILED:', error instanceof Error ? error.message : String(error))
} finally {
  restore()
  console.log(ok ? '\nPASS' : '\nFAIL')
  process.exit(ok ? 0 : 1)
}
