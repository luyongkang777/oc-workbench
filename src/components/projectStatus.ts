/**
 * 顶栏项目标签上的状态灯：这个项目里有没有 AI 正在生成。
 *
 * 数据从服务端会话列表推出来，不看「当前打开的是哪个项目」——切到别的标签后，
 * 原来那个还在跑的项目必须继续亮着。所以判定做成纯函数，由 useProjectRunning
 * 定时拉一次会话列表喂进来，这里只负责「哪些目录在跑」。
 *
 * 不 import api/chat：那个模块会拖进 fetch / token，node 直接单测跑不起来。
 */
import { normKey } from './projectList.ts'

/** 会话里真正用到的字段，其余不管。 */
export type SessionLike = {
  time?: { busy?: number; idle?: number }
  location?: { directory?: string }
  metadata?: Record<string, unknown>
}

/** 与 api/chat 的 WORKBENCH_SOURCE 同一个值，工作台自己建的会话打这个标记。 */
const WORKBENCH_SOURCE = 'oc-workbench'

/** busy 比 idle 新 = 正在生成（和 api/chat 的 isSessionBusy 同判据）。 */
export function isSessionRunning(session: SessionLike): boolean {
  const busy = session.time?.busy ?? 0
  const idle = session.time?.idle ?? 0
  return busy > idle
}

/**
 * 只有工作台的对话会话才算「AI 在跑」。
 * 终端会话跑命令时同样会在 time 上写 busy，那是底部命令栏在干活，
 * 让它把标签灯点成黄色会误导人。
 */
function countsForLight(session: SessionLike): boolean {
  return session.metadata?.source === WORKBENCH_SOURCE && session.metadata?.kind !== 'terminal'
}

/** 从会话列表里挑出正在生成的目录，返回规范化路径集合。 */
export function runningDirectories(sessions: SessionLike[]): Set<string> {
  const out = new Set<string>()
  for (const session of sessions) {
    if (!countsForLight(session)) continue
    if (!isSessionRunning(session)) continue
    const directory = session.location?.directory
    if (directory) out.add(normKey(directory))
  }
  return out
}

/** 某个项目是否在跑：入参是项目原始路径，内部按 normKey 比（大小写/斜杠都认）。 */
export function isProjectRunning(running: Set<string>, path: string): boolean {
  return running.has(normKey(path))
}

/** 内容一样就复用旧引用，否则每轮轮询都会把所有标签重渲一遍。 */
export function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left === right) return true
  if (left.size !== right.size) return false
  for (const item of left) if (!right.has(item)) return false
  return true
}
