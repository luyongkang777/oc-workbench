import { DEFAULT_GATEWAY } from '../api/gateway'

/**
 * 未登录时的登录表单。
 *
 * 纯展示：所有状态和提交逻辑都在 useAccountSession 里。
 * 拆出来是因为它占 AccountPanel 的一半行数，且和「已登录」分支互不相关。
 */
export default function AccountLoginForm({
  name,
  setName,
  password,
  setPassword,
  base,
  setBase,
  editBase,
  setEditBase,
  error,
  busy,
  submitLogin,
}: {
  name: string
  setName: (v: string) => void
  password: string
  setPassword: (v: string) => void
  base: string
  setBase: (v: string) => void
  editBase: boolean
  setEditBase: (fn: (v: boolean) => boolean) => void
  error: string
  busy: boolean
  submitLogin: () => Promise<void>
}) {
  return (
    <div className="account-body">
      <label className="account-label" htmlFor="acc-user">
        用户名
      </label>
      <input
        id="acc-user"
        className="account-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoComplete="username"
        autoCapitalize="off"
        spellCheck={false}
      />
      <label className="account-label" htmlFor="acc-pass">
        密码
      </label>
      <input
        id="acc-pass"
        className="account-input"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submitLogin()
        }}
      />

      {editBase ? (
        <>
          <label className="account-label" htmlFor="acc-base">
            网关地址
          </label>
          <input
            id="acc-base"
            className="account-input"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            spellCheck={false}
          />
        </>
      ) : null}

      {error ? <div className="account-error">{error}</div> : null}

      <button type="button" className="account-primary" onClick={() => void submitLogin()} disabled={busy}>
        {busy ? '登录中…' : '登录'}
      </button>
      <button type="button" className="account-link" onClick={() => setEditBase((v) => !v)}>
        {editBase ? '收起地址设置' : `服务器：${base || DEFAULT_GATEWAY}`}
      </button>
      <p className="account-hint">登录后能看到这个账号绑定的所有电脑，点一下就能远程打开。</p>
    </div>
  )
}
