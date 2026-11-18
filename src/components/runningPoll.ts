/**
 * 「会话在不在生成」轮询的纯判定部分。
 *
 * 抽出来的原因：这条规则里有两个坑都只能靠回归测试挡住，而在 hook 里
 * 没法直接测（要 React 渲染环境）：
 *
 *   1. **空闲也要兜底轮询**。以前只在「自认为在跑」时轮询，一次误判就永久停住，
 *      界面看起来像没在跑，只有切走再切回（重新挂载）才恢复 —— 用户报的正是这个。
 *   2. **失败不能清状态**。请求失败多半是网络抖动，清掉 running 会让「停止」
 *      按钮消失、用户还能再发一条，比停着更糟。
 *
 * 不 import api/chat：那个模块会拖进 fetch / token，node 单测跑不起来。
 */

/** 生成中 / 空闲时各自的轮询间隔（本地、远程两套）。 */
export type PollIntervals = {
  busy: number
  idle: number
}

export const LOCAL_INTERVALS: PollIntervals = { busy: 800, idle: 2500 }
export const REMOTE_INTERVALS: PollIntervals = { busy: 2000, idle: 5000 }

/** 按「是否生成中」取间隔。远程页面整体降速，别拿公网往返当心跳打。 */
export function pollDelay(intervals: PollIntervals, running: boolean): number {
  return running ? intervals.busy : intervals.idle
}

/** busy 比 idle 新 = 正在生成（和 api/chat 的 isSessionBusy 同判据）。 */
export function looksBusy(session: { time?: { busy?: number; idle?: number } } | null): boolean {
  const busy = session?.time?.busy ?? 0
  const idle = session?.time?.idle ?? 0
  return busy > idle
}

/**
 * 一次成功查询之后，新的 runningID 该是什么。
 *
 * 查到 busy → 就是这条会话在跑；查到空闲 → null。
 * 注意入参 id 一定是「本次查询的那条会话」，不要拿上一次的 id 顶，
 * 否则切会话的瞬间会把 A 的结论写到 B 上。
 */
export function nextRunningID(
  sessionID: string,
  session: { time?: { busy?: number; idle?: number } } | null,
): string | null {
  return looksBusy(session) ? sessionID : null
}

/**
 * 手动点「停止」之后的抑制窗口。
 *
 * 中断返回成功时本地立刻清掉「在跑」，但服务端可能还要几十到几百毫秒
 * 才把 busy 改成 idle。这段窗口里照实读服务端，按钮会从「发送」闪回
 * 「停止」再变回来，看着像点了没生效。
 *
 * 取值要盖住远程页面的最慢轮询间隔（2 秒），否则窗口还没被看到就过期了。
 */
export const STOP_GRACE_MS = 2500

/** 抑制窗口的现场快照。 */
export type StopGuard = {
  /** 窗口截止时刻（本机时钟）。 */
  until: number
  /** 停止那一刻服务端给的 busy 时间戳（0 = 当时还没读到过）。 */
  busyAt: number
  /** 停止发生在哪条会话；切走之后窗口不再适用。 */
  sessionID: string
}

export const NO_STOP_GUARD: StopGuard = { until: 0, busyAt: 0, sessionID: '' }

/**
 * 抑制窗口内把「在跑」当成「已停」；窗口外照实读。
 *
 * 窗口内有两种情况必须放行：
 *
 * 1. **已经换了会话**：窗口是给上一次停止留的，不能拿去压别的会话。
 * 2. **停止后又起了一轮**：服务端 busy 比「停止那一刻看到的 busy」新。
 *    这里比的是两个服务端时间戳（同域），不拿本机时钟去和服务端比 ——
 *    远程页面上两台机器差几秒很常见，跨时钟比较两边都会判错。
 */
export function respectStopGrace(
  busy: boolean,
  now: number,
  guard: StopGuard,
  sessionID: string,
  busyAt = 0,
): boolean {
  if (!busy) return false
  if (now >= guard.until) return true
  if (guard.sessionID !== sessionID) return true
  return busyAt > 0 && guard.busyAt > 0 && busyAt > guard.busyAt
}

