import { useDeviceStrip } from '../hooks/useDeviceStrip'
import type { GatewayDevice } from '../api/gateway'

/**
 * 顶部设备切换条：同账号下在线的电脑，点一下切过去。
 *
 * 灯的读法（用户口径）：
 *   * 黄灯呼吸 = 这台电脑上有会话正在跑；
 *   * 绿灯常亮 = 在线但空闲（上一步已经结束）；
 *   * 当前所在的那台高亮，点它不动作。
 *
 * 只有一台在线时不显示 —— 没得切，白占一行。
 */

/** 计算机名可能很长（`DESKTOP-9F2K1LQ`），截断避免一台机器吃掉整条 */
function chipName(dev: GatewayDevice): string {
  const text = (dev.name || '这台电脑').trim()
  return text.length > 12 ? `${text.slice(0, 12)}…` : text
}

/** ID 后 6 位：同名电脑（两台都叫 LU）靠这个区分 */
function chipId(id: string): string {
  return id.length > 6 ? id.slice(-6) : id
}

function title(dev: GatewayDevice): string {
  const state = dev.busy ? '正在跑' : '空闲'
  return `${dev.name}（${dev.id}）· ${state}`
}

export default function DeviceStrip() {
  const { devices, currentId, switching, switchTo } = useDeviceStrip()
  // 一台（或零台）在线：切无可切，不占地方
  if (devices.length < 2) return null

  return (
    <div className="dev-strip" role="tablist" aria-label="同账号下的在线电脑">
      {devices.map((dev) => {
        const active = dev.id === currentId
        const waiting = switching === dev.id
        return (
          <button
            key={dev.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`dev-chip${active ? ' active' : ''}`}
            title={title(dev)}
            // 切到一半就锁住整条，避免连点两台机器互相打断
            disabled={switching !== ''}
            onClick={() => switchTo(dev.id)}
          >
            <span className={`dev-light${dev.busy ? ' busy' : ''}`} aria-hidden="true" />
            <span className="dev-chip-name">{chipName(dev)}</span>
            <span className="dev-chip-id">{chipId(dev.id)}</span>
            {waiting ? <span className="dev-chip-wait">连接中</span> : null}
          </button>
        )
      })}
    </div>
  )
}
