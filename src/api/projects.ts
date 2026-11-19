/**
 * 项目清单的持久化通道。
 *
 * 走法：外壳是唯一的落盘位置（%LOCALAPPDATA%\oc-workbench\projects.json）。
 * 页面发 `oc:projects` 要清单，外壳回 `projects:<json>`；改动时发
 * `oc:projects-save:<json>`。清单内容（去重/排序/每个项目的界面状态）由前端
 * `components/projectList.ts` 负责，外壳只存不管。
 *
 * 为什么不用 localStorage：本地服务的端口可能在两次启动间变化（默认随机端口，
 * 只有远程模式才固定），origin 跟着变，localStorage 跨不了启动。dev/浏览器没有
 * 外壳时才退化成 localStorage。
 */

import { isRemoteHost, onIpcMessage } from './auth'
import { withBase } from './base.ts'
import { parseProjects, type Project } from '../components/projectList'

const LS_KEY = 'oc-workbench:projects'
/** 外壳没回清单时的重试与兜底时间（旧版 exe 不会回这条消息）。 */
const RETRY_MS = 1500
const FALLBACK_MS = 4000

type WindowWithIpc = Window & { ipc?: { postMessage(message: string): void } }

/** 浏览器/远程访问：走 HTTP（cookie 已在入口换过）。 */
async function fetchProjectsHttp(): Promise<Project[] | null> {
  try {
    const res = await fetch(withBase('/local/projects'), {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    return parseProjects(await res.json())
  } catch {
    return null
  }
}

/** 浏览器/远程访问：写回清单。成功返回 true。 */
async function saveProjectsHttp(list: Project[]): Promise<boolean> {
  try {
    const res = await fetch(withBase('/local/projects'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(list),
    })
    return res.ok
  } catch {
    return false
  }
}

export function hasShellIpc(): boolean {
  // 远程页面（网关 IP/域名）在 WebView2 里同样能看到 window.ipc，但外壳按 origin
  // 拒绝非本机页面的消息 —— 「有 IPC 桥」不等于「能用 IPC」。
  // 不排除远程页面的话，项目清单会先发一条 oc:projects、等 4 秒超时，
  // 再退回新 origin 上空的 localStorage，界面永远停在「选一个文件夹」。
  if (isRemoteHost()) return false
  return Boolean((window as WindowWithIpc).ipc?.postMessage)
}

function readLocal(): Project[] {
  try {
    return parseProjects(JSON.parse(window.localStorage.getItem(LS_KEY) ?? '[]'))
  } catch {
    return []
  }
}

/** 清掉 localStorage 里的旧清单：迁移到服务端之后它就不再是数据源。 */
function dropLocal() {
  try {
    window.localStorage.removeItem(LS_KEY)
  } catch {
    // 存储不可用只影响下次启动的迁移，不影响本次
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
  if (!hasShellIpc()) {
    // 浏览器/远程访问：没有 IPC，改走 HTTP；失败再退 localStorage。
    void fetchProjectsHttp().then((list) => {
      /*
       * 服务端清单是空的、而本机还留着旧数据（升级前只能存 localStorage）：
       * 先搬过去再显示。不搬的话用户看到的就是「项目全没了」，
       * 而且在换 origin（localhost ↔ 127.0.0.1 ↔ 局域网 IP）时白丢一次。
       *
       * 搬完必须把 localStorage 清掉：否则用户以后「删光所有项目」时，
       * 服务端存的是空数组、本地这份旧清单还在，下次启动又被搬回去 ——
       * 删掉的项目会自己复活。只搬一次，之后 localStorage 不再是数据源。
       */
      if (!list || list.length === 0) {
        const local = readLocal()
        if (local.length > 0) {
          persistProjects(local)
          dropLocal()
          finish(local)
          return
        }
      }
      finish(list ?? readLocal())
    })
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
  if (hasShellIpc()) {
    try {
      w.ipc?.postMessage(`oc:projects-save:${JSON.stringify(list)}`)
      return
    } catch {
      // 落到下面的 localStorage
    }
  }
  // 没有外壳：先试 HTTP（远程访问），失败再退 localStorage（dev）。
  void saveProjectsHttp(list).then((ok) => {
    if (ok) return
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(list))
    } catch {
      // 存储不可用只影响下次启动的恢复，不影响本次
    }
  })
}
