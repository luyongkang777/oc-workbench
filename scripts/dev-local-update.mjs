// dev 的更新接口：用于在浏览器里验收更新面板（进度条 / 不被检查覆盖 / 更新后停止检测）。
//
// 只在 `npm run dev` 下生效，不真下载、不替换 exe：
//   GET  /local/update/config    → 设置
//   GET  /local/update/check     → 假的「有新版本」
//   GET  /local/update/progress  → 当前进度
//   POST /local/update/apply     → 模拟下载（约 4 秒，推进真实进度）
//   POST /local/update/{auto,skip,source} → 直接成功
//
// 语义对齐 Rust：apply 是阻塞到「下载完」才返回，进度靠 progress 轮询。

import { readFileSync } from 'node:fs'

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version
/** 假的最新版本：一定比当前大，面板才会出现「立即更新」。 */
const FAKE_LATEST = '9.9.9'
/** 假的包大小：8MB，进度按 40 步推进。 */
const FAKE_SIZE = 8 * 1024 * 1024
const STEPS = 40
const STEP_MS = 80

const idle = () => ({ active: false, stage: 'idle', done: 0, total: 0, percent: null, error: null })
let progress = idle()
/** 同一时刻只允许一次模拟下载（前端按钮会锁，但脚本可能连点）。 */
let running = false
/** 下一轮 apply 是否模拟失败（验收「失败后重试」这条路径用）。 */
let failNext = false
/** 下一轮 apply 是否模拟「HTTP 断连，但下载在后台继续」。 */
let networkFailNext = false

function set(stage, done, total) {
  progress = {
    active: true,
    stage,
    done,
    total,
    percent: total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : null,
    error: null,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve) => {
    let text = ''
    req.on('data', (chunk) => {
      text += chunk
    })
    req.on('end', () => resolve(text))
    req.on('error', () => resolve(''))
  })
}

/** 模拟一次下载：3.2 秒推进到 100%，再校验 0.9 秒，最后停在 restarting。 */
async function simulateDownload(fromStep = 1) {
  if (fromStep <= 1) progress = idle()
  for (let step = fromStep; step <= STEPS; step += 1) {
    set('downloading', Math.round((FAKE_SIZE * step) / STEPS), FAKE_SIZE)
    await sleep(STEP_MS)
  }
  set('verifying', FAKE_SIZE, FAKE_SIZE)
  await sleep(900)
  set('restarting', FAKE_SIZE, FAKE_SIZE)
}

export function localUpdatePlugin() {
  return {
    name: 'oc-dev-local-update',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const raw = req.url ?? ''
        if (!raw.startsWith('/local/update')) return next()
        const url = new URL(raw, 'http://127.0.0.1')
        const action = url.pathname.split('/').pop()

        if (action === 'config') {
          sendJson(res, 200, {
            autoCheck: true,
            source: 'https://example.com/latest.json',
            skipped: null,
          })
          return
        }

        if (action === 'check') {
          sendJson(res, 200, {
            configured: true,
            current: VERSION,
            source: 'https://example.com/latest.json',
            latest: FAKE_LATEST,
            newer: true,
            skipped: false,
            autoCheck: true,
            notes: 'dev 模拟更新：用于验收进度条（不会真的替换任何文件）。',
            size: FAKE_SIZE,
            url: null,
            error: null,
          })
          return
        }

        if (action === 'progress') {
          sendJson(res, 200, progress)
          return
        }

        if (req.method !== 'POST') {
          sendJson(res, 405, { error: `${action} 只支持 POST` })
          return
        }

        if (action === 'simulate') {
          await readBody(req)
          failNext = url.searchParams.get('fail') === '1'
          networkFailNext = url.searchParams.get('network') === '1'
          sendJson(res, 200, { ok: true, failNext, networkFailNext })
          return
        }

        if (action === 'apply') {
          await readBody(req)
          if (running) {
            sendJson(res, 409, { ok: false, error: '已经有一个更新在进行中' })
            return
          }
          running = true
          let keepRunning = false
          try {
            if (networkFailNext) {
              networkFailNext = false
              // 先推进到约 20%，再把 HTTP 层打断；下载在后台继续跑完。
              // 前端应当按真实进度继续跟随，而不是把界面钉成失败。
              for (let step = 1; step <= 8; step += 1) {
                set('downloading', Math.round((FAKE_SIZE * step) / STEPS), FAKE_SIZE)
                await sleep(STEP_MS)
              }
              keepRunning = true
              void simulateDownload(9).finally(() => {
                running = false
              })
              sendJson(res, 500, { ok: false, error: '模拟网络中断' })
              return
            }
            if (failNext) {
              failNext = false
              // 先让进度走到约 30%，界面能看到进度条再变成失败态
              for (let step = 1; step <= 12; step += 1) {
                set('downloading', Math.round((FAKE_SIZE * step) / STEPS), FAKE_SIZE)
                await sleep(STEP_MS)
              }
              progress = {
                active: false,
                stage: 'failed',
                done: progress.done,
                total: progress.total,
                percent: progress.percent,
                error: '模拟失败：SHA256 不符',
              }
              sendJson(res, 400, { ok: false, error: '模拟失败：SHA256 不符' })
              return
            }
            await simulateDownload()
            sendJson(res, 200, { ok: true, version: FAKE_LATEST })
          } finally {
            // 后台仍在跑的那一支由它自己的 finally 复位，这里别抢
            if (!keepRunning) running = false
          }
          return
        }

        if (action === 'auto' || action === 'skip' || action === 'source') {
          await readBody(req)
          sendJson(res, 200, { ok: true })
          return
        }

        sendJson(res, 404, { error: `未知的更新接口：${action}` })
      })
    },
  }
}
