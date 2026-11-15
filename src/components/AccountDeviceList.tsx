import type { GatewayDevice } from '../api/gateway'

/** 在线/离线文案：在线显示「在线」，离线显示最后一次登记时间。 */
function whenText(dev: GatewayDevice): string {
  if (dev.online) return '在线'
  if (!dev.lastSeen) return '从未连接'
  const d = new Date(dev.lastSeen * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 设备短标识（ID 后 6 位）。
 *
 * 两台电脑的计算机名经常一模一样（都是 `DESKTOP-XXXX` 或用户都叫「LU」），
 * 只显示名字根本分不清哪台是哪台。ID 是每台机器唯一的，取后 6 位够读又不占地方。
 */
function shortId(id: string): string {
  return id.length > 6 ? id.slice(-6) : id
}

/**
 * 已登录后的设备列表。
 *
 * 纯展示：状态在 useAccountSession，点按行为通过 props 回传。
 */
export default function AccountDeviceList({
  username,
  devices,
  busy,
  error,
  claimHint,
  logout,
  openDevice,
  refresh,
}: {
  username: string
  devices: GatewayDevice[]
  busy: boolean
  error: string
  claimHint: string
  logout: () => void
  openDevice: (dev: GatewayDevice) => Promise<void>
  refresh: () => void
}) {
  return (
    <div className="account-body">
      <div className="account-user">
        <span className="account-user-name">{username}</span>
        <button type="button" className="account-link" onClick={logout}>
          退出
        </button>
      </div>

      {error ? <div className="account-error">{error}</div> : null}
      {claimHint ? <div className="account-error">{claimHint}</div> : null}

      <div className="account-list">
        {devices.length === 0 && !busy ? (
          <div className="account-empty">
            这个账号还没有电脑。
            <br />
            在任意一台电脑上打开工作台，用这个账号登录一次即可自动登记。
          </div>
        ) : null}
        {devices.map((dev) => (
          <button
            key={dev.id}
            type="button"
            className="account-device"
            onClick={() => void openDevice(dev)}
          >
            <span className={`account-dot${dev.online ? ' on' : ''}`} aria-hidden="true" />
            <span className="account-device-main">
              <span className="account-device-name">{dev.name}</span>
              <span className="account-device-meta">
                {whenText(dev)} · {shortId(dev.id)}
              </span>
            </span>
            <span className="account-device-open">打开</span>
          </button>
        ))}
      </div>

      <button type="button" className="account-link" onClick={refresh} disabled={busy}>
        {busy ? '刷新中…' : '刷新列表'}
      </button>
    </div>
  )
}
