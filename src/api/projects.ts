/**
 * 项目清单的持久化通道。
 *
 * 走法：外壳是唯一的落盘位置（%LOCALAPPDATA%\oc-workbench\projects.json）。
 * 页面发 `oc:projects` 要清单，外壳回 `projects:<json>`；改动时发
 * `oc:projects-save:<json>`。清单内容（去重/排序/每个项目的界面状态）由前端
 * `components/projectList.ts` 负责，外壳只存不管。
 *
 * 为什么不用 localStorage：本地服务端口每次启动都变，origin 跟着变，
 * localStorage 跨不了启动。dev/浏览器没有外壳时才退化成 localStorage。
 */

import { onIpcMessage } from './auth'
import { parseProjects, type Project } from '../components/projectList'

const LS_KEY = 'oc-workbench:projects'
/** 外壳没回清单时的重试与兜底时间（旧版 exe 不会回这条消息）。 */
const RETRY_MS = 1500
const FALLBACK_MS = 4000

type WindowWithIpc = Window & { ipc?: { postMessage(message: string): void } }

export function hasShellIpc(): boolean {
  return Boolean((window as WindowWithIpc).ipc?.postMessage)
}

function readLocal(): Project[] {
  try {
    return parseProjects(JSON.parse(window.localStorage.getItem(LS_KEY) ?? '[]'))
  } catch {
    return []
  }
}

/**
 * 启动时取一次清单。
 * `onReady` 只会被调一次：拿到外壳回复、或超时退回 localStorage。
 */
export function startProjects(onReady: (list: Project[]) => void): () => void {
  let done = false
  const finish = (list: Project[]) => {
    if (done) return
    done = true
    onReady(list)
  }

  const w = window as WindowWithIpc
  if (!w.ipc?.postMessage) {
    finish(readLocal())
    return () => {}
  }

  const off = onIpcMessage((message) => {
    if (!message.startsWith('projects:')) return
    let raw: unknown = []
    try {
      raw = JSON.parse(message.slice('projects:'.length) || '[]')
    } catch {
      raw = []
    }
    off()
    finish(parseProjects(raw))
  })

  const send = () => {
    try {
      w.ipc?.postMessage('oc:projects')
    } catch {
      // 外壳不在就等下面的兜底
    }
  }
  send()
  const retry = window.setTimeout(() => {
    if (!done) send()
  }, RETRY_MS)
  const fallback = window.setTimeout(() => {
    if (!done) finish(readLocal())
  }, FALLBACK_MS)

  return () => {
    off()
    window.clearTimeout(retry)
    window.clearTimeout(fallback)
  }
}

/** 写回清单：有外壳就落 projects.json，否则写 localStorage（dev 用）。 */
export function persistProjects(list: Project[]): void {
  const w = window as WindowWithIpc
  if (w.ipc?.postMessage) {
    try {
      w.ipc.postMessage(`oc:projects-save:${JSON.stringify(list)}`)
      return
    } catch {
      // 落到下面的 localStorage
    }
  }
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(list))
  } catch {
    // 存储不可用只影响下次启动的恢复，不影响本次
  }
}
