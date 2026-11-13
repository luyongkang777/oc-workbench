import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { localFsPlugin } from './scripts/dev-local-fs.mjs'
import { localGitPlugin } from './scripts/dev-local-git.mjs'
import { localPurgePlugin } from './scripts/dev-local-purge.mjs'
import { localRemotePlugin } from './scripts/dev-local-remote.mjs'
import { exec } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'

/** 版本号只在构建时注入一次，运行时不再问外壳（顶栏那颗版本号用它）。 */
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string

const execAsync = promisify(exec)
const FALLBACK_TARGET = 'http://127.0.0.1:28894'
/**
 * 联调/自动化验收用的固定上游：设了就直接指向它，不再跑 `opencode pair`。
 * 本地 mock 后端、录制回放服务都靠这个口子接进来（否则 pair 的 20 秒超时
 * 会拖住 dev server 启动）。
 */
const OVERRIDE_TARGET = process.env.OC_WORKBENCH_TARGET?.trim() ?? ''
const PAIR_LINK_RE = /http:\/\/127\.0\.0\.1:(\d+)\/auth\/connect\/[A-Za-z0-9_-]+/
/** 配对链接请求的超时：对端不收连接时不能让 dev server 启动卡死。 */
const PAIR_FETCH_TIMEOUT_MS = 10_000

type Auth = { cookie: string; target: string }

/**
 * 自动完成 opencode 认证：
 * opencode pair 拿到一次性配对链接 → 带 Accept: text/html 请求 → 从 Set-Cookie 取 session token。
 * 失败时降级为无 cookie（前端会显示「未连接」），但 dev server 必须还能起来。
 */
async function resolveAuth(): Promise<Auth> {
  if (OVERRIDE_TARGET) {
    console.log(`[oc-workbench] 使用指定上游：${OVERRIDE_TARGET}（跳过 pair）`)
    return { cookie: '', target: OVERRIDE_TARGET }
  }
  try {
    const { stdout, stderr } = await execAsync('opencode pair', {
      timeout: 20000,
      windowsHide: true,
    })
    const text = `${stdout}\n${stderr ?? ''}`
    const match = PAIR_LINK_RE.exec(text)
    if (!match) throw new Error('没有解析到配对链接')

    const port = match[1]
    const link = match[0]
    const res = await fetch(link, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(PAIR_FETCH_TIMEOUT_MS),
    })
    const raw =
      (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie()[0] : undefined) ??
      res.headers.get('set-cookie') ??
      ''
    const m = new RegExp(`(opencode_session_${port})=([^;]+)`).exec(raw)
    if (!m) throw new Error(`Set-Cookie 里没有 opencode_session（status=${res.status}）`)

    console.log(`[oc-workbench] 已配对 OpenCode 服务：http://127.0.0.1:${port}`)
    return { cookie: `${m[1]}=${m[2]}`, target: `http://127.0.0.1:${port}` }
  } catch (err) {
    console.warn(
      `[oc-workbench] 自动认证失败：${(err as Error).message}；先按无认证启动，界面会显示未连接`,
    )
    return { cookie: '', target: FALLBACK_TARGET }
  }
}

export default defineConfig(async ({ command, isPreview }) => {
  // 只有 dev server 才参与配对：build / preview（command 也是 serve）走配对会白白
  // 消耗一次性链接，构建机上没装 opencode 时还会打印误导性告警。
  const shouldPair = command === 'serve' && !isPreview
  const auth: Auth = shouldPair ? await resolveAuth() : { cookie: '', target: FALLBACK_TARGET }

  return {
    define: {
      __APP_VERSION__: JSON.stringify(VERSION),
    },
    // 顺序有意义：LocalFs 拦的是所有 `/local/*`，Git / Remote / Purge 必须排它前面，
    // 否则 `/local/git/status`、`/local/remote/accounts`、`/local/purge/status`
    // 会被 fs 插件接走（回「未知的本地文件接口」）。
    plugins: [react(), localGitPlugin(), localRemotePlugin(), localPurgePlugin(), localFsPlugin()],
    server: {
      port: 5273,
      strictPort: true,
      watch: {
        // Rust 外壳的编译产物被占用时，watcher 会 EBUSY 把 dev server 直接搞崩
        ignored: ['**/shell/**', '**/target/**', '**/dist/**', '**/.git/**', '**/.tmp/**'],
      },
      proxy: {
        '/api': {
          target: auth.target,
          changeOrigin: true,
          ws: true,
          configure: (proxy: any) => {
            // dev 没有外壳的 token 门禁（/api 直连 opencode，用 cookie 认证），
            // x-oc-token 是工作台私有头，别顺着代理泄漏给上游。
            proxy.on('proxyReq', (proxyReq: any) => {
              proxyReq.removeHeader('x-oc-token')
              // 浏览器给同源 POST 带的 Origin 是 5273，opencode 会当跨站拒掉（401）
              proxyReq.removeHeader('origin')
              proxyReq.removeHeader('referer')
              if (auth.cookie) proxyReq.setHeader('cookie', auth.cookie)
            })
            proxy.on('proxyReqWs', (proxyReq: any) => {
              proxyReq.removeHeader('x-oc-token')
              // 浏览器给同源 POST 带的 Origin 是 5273，opencode 会当跨站拒掉（401）
              proxyReq.removeHeader('origin')
              proxyReq.removeHeader('referer')
              if (auth.cookie) proxyReq.setHeader('cookie', auth.cookie)
            })
            // SSE 不能被缓冲；只改头，绝对不要 flushHeaders（会把上游 content-type 吃掉）
            proxy.on('proxyRes', (proxyRes: any) => {
              if (String(proxyRes.headers['content-type'] ?? '').includes('text/event-stream')) {
                proxyRes.headers['cache-control'] = 'no-cache, no-transform'
                proxyRes.headers['x-accel-buffering'] = 'no'
              }
            })
          },
        },
      },
    },
  }
})
