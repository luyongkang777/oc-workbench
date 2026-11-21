import { authToken, withBase } from './base.ts'
import { normalizeSkills, type SkillInfo } from '../components/skillList'

/**
 * 技能清单（`GET /api/skill`）。
 *
 * 和 MCP 一样是「目录级」的：每条会话都在某个目录里，传 location 就能拿到
 * 这个目录可见的那批技能（全局 + 项目内）。
 *
 * 服务端不支持裁字段（试过 content=false / fields=... 都没用），响应里会带
 * 每个技能的完整正文；这里只保留元数据，正文在 skillList.ts 里就丢掉了。
 *
 * 响应约 1.5 MB（155 条），手机远程打开一次要等好几秒、还费流量，
 * 所以按目录缓存 60 秒；面板上的「重新读取」用 force 绕过。
 */

const REQUEST_TIMEOUT_MS = 15000
const CACHE_TTL_MS = 60_000

const cache = new Map<string, { at: number; list: SkillInfo[] }>()

async function call<T>(path: string): Promise<T> {
  const headers = new Headers()
  // dev 模式走 Vite 代理（cookie 由代理注入），这时没有 token；
  // 别发空的 x-oc-token，否则会被上游当成带了错误凭据。
  const current = authToken()
  if (current) headers.set('x-oc-token', current)

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(withBase(path), { headers, cache: 'no-store', signal: controller.signal })
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  } catch (err) {
    if (timedOut) throw new Error('读取技能列表超时')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** 拉当前目录可见的技能，已清洗、已排序；60 秒内重复调用走缓存。 */
export async function fetchSkills(
  root?: string,
  options: { force?: boolean } = {},
): Promise<SkillInfo[]> {
  const key = root ?? ''
  const hit = cache.get(key)
  if (!options.force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.list

  const query = root ? `?location%5Bdirectory%5D=${encodeURIComponent(root)}` : ''
  const list = normalizeSkills(await call<unknown>(`/api/skill${query}`))
  cache.set(key, { at: Date.now(), list })
  return list
}
