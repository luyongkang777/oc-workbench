// Vite dev server 的项目清单中间件：接口与 Rust 外壳的 `/local/projects` 对齐。
//
// 生产走 `shell/src/projects.rs`，落 `%LOCALAPPDATA%\oc-workbench\projects.json`。
// dev 没有外壳时前端会退化成 localStorage，而 localStorage 按 origin 分区：
//
//   http://localhost:5273  和  http://127.0.0.1:5273  是两个 origin
//   手机用局域网 IP 访问又是第三个
//
// 换一个入口打开，清单就是空的，界面只剩启动时自动加入的那一个项目 ——
// 表现成「重新打开界面，项目就只剩一个」。这里用 Node 读写同一个文件，
// dev / 浏览器 / 手机远程共用一份清单，和 exe 行为一致。
//
// 只读写清单本身：去重、排序、每个项目的界面状态由前端 `projectList.ts` 负责。

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** 与外壳 projects::MAX_BYTES 一致：超过 1 MB 基本是写坏了，不落盘。 */
const MAX_BYTES = 1024 * 1024
const BODY_LIMIT = MAX_BYTES + 1024

/** 与 Rust 侧 `projects::projects_file()` 同一套路径。 */
export function projectsFile(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local')
  return path.join(base, 'oc-workbench', 'projects.json')
}

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/** 读清单：文件不在、内容不像数组，都回空清单让前端从零开始。 */
export async function loadProjects(file = projectsFile()) {
  try {
    const text = (await readFile(file, 'utf8')).trim()
    if (text.startsWith('[') && text.endsWith(']')) return text
  } catch {
    // 文件不存在就是空清单，不是错误
  }
  return '[]'
}

/** 与外壳 `check()` 同样的把关：非空、不超限、必须是 JSON 数组。 */
function checkProjects(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) throw httpError(400, '清单是空的')
  if (trimmed.length > MAX_BYTES) throw httpError(413, `清单过大（${trimmed.length} 字节，上限 ${MAX_BYTES}）`)
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) throw httpError(400, '清单必须是 JSON 数组')
  try {
    if (!Array.isArray(JSON.parse(trimmed))) throw new Error('顶层不是数组')
  } catch (err) {
    throw httpError(400, `清单不是合法 JSON 数组（${err.message}）`)
  }
  return trimmed
}

/**
 * 写清单：先写临时文件再 rename。
 *
 * dev server 和 exe 可能同时开着，直接 writeFile 会让对方读到半个文件；
 * rename 在同一个目录内是原子的，最坏也只是读到上一次的完整内容。
 */
export async function saveProjects(json, file = projectsFile()) {
  const text = checkProjects(json)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, text, 'utf8')
  try {
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true })
    throw httpError(500, `写清单失败：${err.message}`)
  }
  return text
}

async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > BODY_LIMIT) throw httpError(413, '请求体过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

export async function handleProjects(req, res) {
  if (req.method === 'GET') {
    return sendJson(res, 200, await loadProjects())
  }
  if (req.method === 'POST') {
    const saved = await saveProjects(await readBody(req))
    return sendJson(res, 200, saved)
  }
  throw httpError(405, '只支持 GET 和 POST')
}

/** 只拦 `/local/projects`；必须排在 `localFsPlugin` 前面，否则会被当成文件接口。 */
export function localProjectsPlugin() {
  return {
    name: 'oc-workbench-local-projects',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0]
        if (url !== '/local/projects' && url !== '/local/projects/') {
          next()
          return
        }
        handleProjects(req, res).catch((err) => {
          const status = err.status || 500
          sendJson(res, status, { error: err.message || '项目清单接口失败', status })
        })
      })
    },
  }
}
