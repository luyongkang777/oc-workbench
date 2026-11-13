/**
 * 断开态自动重连的节奏。
 *
 * 背景：以前「未连接」只能靠用户点一次「重试」——探活失败只把红灯点亮，
 * 没有任何东西去重新配对，后端晚起来或中途重开就永远停在未连接。
 *
 * 现在改成自己恢复，节奏按退避走：
 *   * 第一次要快（[`FIRST_RECONNECT_DELAY_MS`]）：冷启动时外壳也在 bootstrap，
 *     错过第一次探活是常态，等 1 秒再补一次就能赶上；
 *   * 之后放慢到 4s → 8s → 12s → 15s：`/api/reconnect` 会真的跑
 *     `opencode service status` + `pair`（一次性的配对链接），不能每秒来一发；
 *   * 页面在后台（`document.hidden`）不跑：后台标签页的定时器本来就被节流，
 *     而且没人看屏幕时白生成配对链接没有意义，回到前台再由可见性事件补一次。
 *
 * 纯函数，不碰 window：node 里能直接单测（见 scripts/connectionPolicy.test.mjs）。
 */

/** 第一次自动重连前的等待：够外壳把第一轮 bootstrap 跑完，又不至于让用户干等。 */
export const FIRST_RECONNECT_DELAY_MS = 1_200
/** 页面在后台时的复查间隔：只检查可见性，真正重连等回到前台。 */
export const HIDDEN_RECHECK_MS = 4_000

/** 连续失败后的退避序列（毫秒），最后一档就是上限。 */
const BACKOFF_MS = [4_000, 8_000, 12_000, 15_000]

/**
 * 第 `attempt` 次自动重连之后该等多久（`attempt` 从 0 开始，表示还没试过）。
 *
 * attempt = 0 → 第一次尝试前的等待；1 → 第二次；以此类推，越界一律取上限。
 */
export function nextReconnectDelay(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) return FIRST_RECONNECT_DELAY_MS
  const index = Math.min(Math.floor(attempt) - 1, BACKOFF_MS.length - 1)
  return BACKOFF_MS[Math.max(0, index)]
}

/** 后台标签页不做重连：等用户真回来再说（可见性变化会立刻补一次探活）。 */
export function shouldReconnectNow(hidden: boolean): boolean {
  return !hidden
}

/** 页面看不见时的复查间隔：只是过一会儿再看看有没有回到前台。 */
export function hiddenRecheckDelay(): number {
  return HIDDEN_RECHECK_MS
}
