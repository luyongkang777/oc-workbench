/**
 * 每条会话上次用的模式（服务端 agent）。
 *
 * 为什么需要记：切换会话标签会让 Chat 重新挂载，`agent` state 回到空串，
 * 界面就显示成第一个 agent（build），可服务端那条会话实际还在 ask/plan/debug 上跑。
 * 服务端会话对象里的 `agent` 是首选来源；它没返回时用这里的本地兜底。
 */

const KEY = 'oc-workbench:session-agent'

/** 解析存储里的 JSON；坏值、数组、非字符串值一律丢掉，不让脏数据把显示带歪。 */
export function parseAgentMemory(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) out[id] = value
    }
    return out
  } catch {
    return {}
  }
}

/** 服务端会话里记的 agent 优先，它没返回时才用本地记忆。 */
export function resolveSessionAgent(
  serverAgent: string | undefined,
  remembered: string | undefined,
): string {
  return serverAgent || remembered || ''
}

function readAll(): Record<string, string> {
  try {
    return parseAgentMemory(window.localStorage.getItem(KEY))
  } catch {
    return {}
  }
}

function writeAll(map: Record<string, string>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    /* 存不进去只影响下次重挂载后的显示 */
  }
}

export function recallSessionAgent(sessionID: string): string | undefined {
  return readAll()[sessionID]
}

/** 记忆表最多留多少条：聊过的会话会越来越多，不设上限的话 localStorage 只增不减。 */
export const MAX_AGENT_ENTRIES = 200

/** 把记忆表裁到上限：对象键顺序就是插入顺序，先删最旧的；没超上限原样返回。 */
export function trimAgentMemory(
  map: Record<string, string>,
  max = MAX_AGENT_ENTRIES,
): Record<string, string> {
  const ids = Object.keys(map)
  if (ids.length <= max) return map
  const out = { ...map }
  for (const id of ids.slice(0, ids.length - max)) delete out[id]
  return out
}

export function rememberSessionAgent(sessionID: string, agent: string): void {
  if (!sessionID || !agent) return
  const map = readAll()
  if (map[sessionID] === agent) return
  // 先删再写：对象键顺序就是插入顺序，这样刚用过的会话排到最后，清理时先淘汰最旧的。
  delete map[sessionID]
  map[sessionID] = agent
  writeAll(trimAgentMemory(map))
}
