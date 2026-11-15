import { useEffect } from 'react'
import AccountDeviceList from './AccountDeviceList'
import AccountLoginForm from './AccountLoginForm'
import { useAccountSession } from '../hooks/useAccountSession'

/**
 * 账号面板：登录网关账号 → 列出同账号下的所有电脑 → 点一下在当前窗口里打开。
 *
 * 打开方式是**顶层导航**（不是 iframe）：exe 顶层是 127.0.0.1、远程是公网 IP，
 * 跨站 iframe 里 SameSite=Lax 的账号 cookie 不会发送，设备入口必然 401。
 * 顶层导航后 origin 变成网关，cookie 才同站；「返回本机」靠 URL 上的 back 参数带回。
 *
 * 这里只负责外壳（遮罩 / 侧栏 / 标题 / 切换两种视图）；
 * 状态在 useAccountSession，两个视图分别在 AccountLoginForm / AccountDeviceList。
 */

type Props = {
  open: boolean
  onClose: () => void
  onOpenDevice: (url: string, name: string) => void
}

export default function AccountPanel({ open, onClose, onOpenDevice }: Props) {
  const s = useAccountSession(open, onOpenDevice)

  useEffect(() => {
    if (!open) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <>
      {open ? <div className="account-mask" onMouseDown={onClose} /> : null}
      <aside className={`account-panel${open ? ' open' : ''}`} aria-hidden={!open}>
        <div className="account-head">
          <span className="account-title">账号</span>
          <button type="button" className="account-close" onClick={onClose} aria-label="关闭账号面板">
            ×
          </button>
        </div>

        {s.token ? (
          <AccountDeviceList
            username={s.username}
            devices={s.devices}
            busy={s.busy}
            error={s.error}
            claimHint={s.claimHint}
            tunnel={s.tunnel}
            logout={s.logout}
            openDevice={s.openDevice}
            refresh={s.refresh}
          />
        ) : (
          <AccountLoginForm
            name={s.name}
            setName={s.setName}
            password={s.password}
            setPassword={s.setPassword}
            base={s.base}
            setBase={s.setBase}
            editBase={s.editBase}
            setEditBase={s.setEditBase}
            error={s.error}
            busy={s.busy}
            submitLogin={s.submitLogin}
          />
        )}
      </aside>
    </>
  )
}
