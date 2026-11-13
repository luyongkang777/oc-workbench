/**
 * 会话条目的状态灯：跟项目标签灯同一套语义。
 *
 *   running = 正在生成（呼吸黄）
 *   idle    = 空闲（常亮绿）
 *   error   = 上一轮报错（常亮红；服务端没给这个字段时不会出现）
 *   unknown = 服务端没连上（灰，不做「空闲」承诺）
 *
 * 不 import api/chat：那个模块会拖进 fetch / token，node 直接单测跑不起来。
 */

/** 会话里真正用到的字段，其余不管。 */
export type SessionLike = {
  id?: string
  time?: { busy?: number; idle?: number }
  metadata?: Record<string, unknown>
}

export type SessionLight = 'running' | 'idle' | 'error' | 'unknown'

/** busy 比 idle 新 = 正在生成（和 api/chat 的 isSessionBusy 同判据）。 */
export function isRunning(session: SessionLike): boolean {
  const busy = session.time?.busy ?? 0
  const idle = session.time?.idle ?? 0
  return busy > idle
}

/**
 * 灯色。
 *
 * connected=false 时一律灰：这时列表可能是几秒前的旧数据，
 * 亮绿灯等于替服务端做「它空闲」的承诺，实际可能正在跑。
 */
export function sessionLight(session: SessionLike, connected: boolean): SessionLight {
  if (!connected) return 'unknown'
  if (isRunning(session)) return 'running'
  // 服务端在 metadata 上写 error 的会话（上一轮生成失败）
  if (session.metadata?.error) return 'error'
  return 'idle'
}

/** 文案：悬停提示用，说清「为什么是这颗颜色」。 */
export function sessionLightTitle(light: SessionLight): string {
  if (light === 'running') return 'AI 正在生成…'
  if (light === 'error') return '上一轮生成失败'
  if (light === 'unknown') return '未连接'
  return '空闲'
}
