/**
 * 选远程仓库的弹层（契约见 docs/remote-accounts-contract.md §3.2）。
 *
 * 三条路径都归到 `onPick(url)`：
 * 1. 手动填写——保住原来内联输入的能力；
 * 2. 选已有仓库——列账号下所有仓库，空仓库排最前；
 * 3. 新建仓库——名字默认取项目目录名。
 *
 * 样式全部在 src/styles/git.css，组件里不 import 任何 CSS。
 * 错误一律显示在卡片内（不 alert / 不 window.confirm）。
 */
import { useCallback, useEffect, useState } from 'react'

import {
  createRemoteRepo,
  deleteAccount,
  listAccounts,
  listRemoteRepos,
  loginWithPassword,
  openExternalUrl,
  probeHost,
  saveAccount,
  type RemoteAccount,
  type RemoteKind,
  type RemoteRepo,
} from '../../api/remote'
import { Icon } from '../Icon'
import { accountLabel, defaultRepoName, sortRepos } from './gitFormat'

type Props = {
  root: string
  open: boolean
  /** 当前 remote 地址（可能为空） */
  current: string
  onPick: (url: string) => void
  onClose: () => void
}

type Tab = 'manual' | 'repos' | 'create'

/** 添加账号的两种取令牌方式：Gitea 用账号密码换，GitHub 只能粘贴 */
type AddMode = 'login' | 'token'

const TABS: { key: Tab; label: string }[] = [
  { key: 'manual', label: '手动填写' },
  { key: 'repos', label: '选已有仓库' },
  { key: 'create', label: '新建仓库' },
]

/** 搜索防抖：后端每次都要真连上游，别按一个字符发一次 */
const SEARCH_DEBOUNCE_MS = 220

const GITHUB_HINT = 'GitHub：Settings → Developer settings → Personal access tokens → 勾 repo'
const GITEA_HINT = 'Gitea：设置 → 应用 → 生成令牌 → 勾 repository'

/** GitHub 预填好 repo 权限的令牌页（契约 §7.3，scope 只要 repo） */
const GITHUB_TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=repo&description=OpenCode%20%E5%B7%A5%E4%BD%9C%E5%8F%B0'

/**
 * GitHub 走不了账号密码（契约 §7.0）：类型选了 GitHub，或选了「自动识别」但地址里
 * 明显是 github.com 时，都锁到「粘贴令牌」。
 */
function isGithubTarget(kind: RemoteKind | '', baseUrl: string): boolean {
  if (kind === 'github') return true
  if (kind === 'gitea') return false
  return /(^|\/\/|\.)github\.com(\/|:|$)/i.test(baseUrl.trim())
}

export default function RemotePicker({ root, open, current, onPick, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('manual')

  const [accounts, setAccounts] = useState<RemoteAccount[] | null>(null)
  const [accountId, setAccountId] = useState('')
  const [accountsBusy, setAccountsBusy] = useState(false)
  const [accountsError, setAccountsError] = useState<string | null>(null)

  // 添加账号是卡片内的二级表单，不跳页
  const [addOpen, setAddOpen] = useState(false)
  const [addKind, setAddKind] = useState<RemoteKind | ''>('')
  const [addBaseUrl, setAddBaseUrl] = useState('')
  const [addMode, setAddMode] = useState<AddMode>('login')
  const [addUsername, setAddUsername] = useState('')
  const [addPassword, setAddPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [addToken, setAddToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [delBusy, setDelBusy] = useState(false)

  const [manualUrl, setManualUrl] = useState(current)
  const [manualError, setManualError] = useState<string | null>(null)

  const [repos, setRepos] = useState<RemoteRepo[] | null>(null)
  const [reposBusy, setReposBusy] = useState(false)
  const [reposError, setReposError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const [repoName, setRepoName] = useState(() => defaultRepoName(root))
  const [repoPrivate, setRepoPrivate] = useState(true)
  const [repoDesc, setRepoDesc] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const loadAccounts = useCallback(async () => {
    setAccountsBusy(true)
    try {
      const list = await listAccounts()
      setAccounts(list)
      setAccountsError(null)
      // 选中的账号被删了就退到第一个，别留下空选择
      setAccountId((prev) => (prev && list.some((item) => item.id === prev) ? prev : (list[0]?.id ?? '')))
    } catch (err) {
      setAccountsError((err as Error).message)
    } finally {
      setAccountsBusy(false)
    }
  }, [])

  // 每次打开都重置本地状态：上次的错误 / 搜索词 / 半填的 token 不该残留
  useEffect(() => {
    if (!open) return
    setTab('manual')
    setAddOpen(false)
    setAddKind('')
    setAddBaseUrl('')
    setAddMode('login')
    setAddUsername('')
    setAddPassword('')
    setShowPassword(false)
    setAddToken('')
    setShowToken(false)
    setAddError(null)
    setAddBusy(false)
    setConfirmDel(null)
    setManualUrl(current)
    setManualError(null)
    setQuery('')
    setRepos(null)
    setReposError(null)
    setRepoName(defaultRepoName(root))
    setRepoPrivate(true)
    setRepoDesc('')
    setCreateError(null)
  }, [open, root, current])

  useEffect(() => {
    if (!open) return
    void loadAccounts()
  }, [open, loadAccounts])

  // 换账号时旧列表立刻作废，避免看到上一个账号的仓库
  useEffect(() => {
    setRepos(null)
    setReposError(null)
  }, [accountId])

  // 选已有仓库：账号 + 搜索词变化时拉一次（防抖）
  useEffect(() => {
    if (!open || tab !== 'repos' || !accountId) return

    let alive = true
    const timer = window.setTimeout(() => {
      setReposBusy(true)
      listRemoteRepos(accountId, query.trim(), 100)
        .then((list) => {
          if (!alive) return
          setRepos(sortRepos(list))
          setReposError(null)
        })
        .catch((err) => {
          if (!alive) return
          setReposError((err as Error).message)
        })
        .finally(() => {
          if (alive) setReposBusy(false)
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [open, tab, accountId, query])

  // Esc：先关二级确认 / 添加表单，最后才关整个弹层
  useEffect(() => {
    if (!open) return
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (confirmDel) setConfirmDel(null)
      else if (addOpen) setAddOpen(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, confirmDel, addOpen, onClose])

  // GitHub 不考虑账号密码：锁到「粘贴令牌」，同时把已选的方式纠正过来
  const githubLocked = isGithubTarget(addKind, addBaseUrl)
  const mode: AddMode = githubLocked ? 'token' : addMode

  useEffect(() => {
    if (githubLocked && addMode !== 'token') setAddMode('token')
  }, [githubLocked, addMode])

  if (!open) return null

  const account = (accounts ?? []).find((item) => item.id === accountId) ?? null
  const noAccount = accountId === ''

  function pick(url: string) {
    const value = url.trim()
    if (!value) return
    onPick(value)
    onClose()
  }

  function handleManual() {
    const value = manualUrl.trim()
    if (!value) {
      setManualError('先填一个仓库地址')
      return
    }
    setManualError(null)
    pick(value)
  }

  function handleUseRepo(repo: RemoteRepo) {
    const url = repo.cloneUrl || repo.sshUrl
    if (!url) {
      setReposError('这个仓库没有可用的 clone 地址，只能手动填')
      return
    }
    pick(url)
  }

  async function handleAdd() {
    if (addBusy) return
    const token = addToken.trim()
    if (!token) {
      setAddError('token 不能为空')
      return
    }
    const baseUrl = (addBaseUrl.trim() || (addKind === 'github' ? 'https://github.com' : '')).replace(
      /\/+$/,
      '',
    )
    if (!baseUrl) {
      setAddError('服务器地址不能为空')
      return
    }

    setAddBusy(true)
    setAddError(null)
    try {
      const probe = await probeHost(baseUrl, token, addKind)
      const saved = await saveAccount({
        kind: probe.kind,
        baseUrl: probe.webUrl || baseUrl,
        token,
        username: probe.username,
      })
      await loadAccounts()
      setAccountId(saved.id)
      setAddOpen(false)
      setAddToken('')
      setShowToken(false)
      setTab('repos')
    } catch (err) {
      setAddError((err as Error).message)
    } finally {
      setAddBusy(false)
    }
  }

  /** 一键登录：密码换令牌 → 直接用令牌存账号，用户不用再点一次保存。 */
  async function handleLogin() {
    if (addBusy) return
    if (githubLocked) {
      setAddError('GitHub 不支持账号密码登录')
      return
    }
    const baseUrl = addBaseUrl.trim().replace(/\/+$/, '')
    if (!baseUrl) {
      setAddError('服务器地址不能为空')
      return
    }
    const username = addUsername.trim()
    if (!username) {
      setAddError('请填 Gitea 用户名')
      return
    }
    if (!addPassword) {
      setAddError('请填密码')
      return
    }

    setAddBusy(true)
    setAddError(null)
    try {
      const login = await loginWithPassword({
        baseUrl,
        username,
        password: addPassword,
        kind: addKind || undefined,
      })
      // 密码用完立刻从组件状态里抹掉，不等表单关闭
      setAddPassword('')
      setShowPassword(false)

      const saved = await saveAccount({
        kind: login.kind,
        baseUrl: login.webUrl || login.baseUrl || baseUrl,
        token: login.token,
        username: login.username || username,
        apiBase: login.apiBase,
      })
      await loadAccounts()
      setAccountId(saved.id)
      setAddOpen(false)
      setAddUsername('')
      setTab('repos')
    } catch (err) {
      setAddError((err as Error).message)
    } finally {
      setAddBusy(false)
    }
  }

  /** GitHub 令牌页交给系统浏览器打开；失败留在卡片里说，不弹窗。 */
  async function handleOpenTokenPage() {
    try {
      await openExternalUrl(GITHUB_TOKEN_URL)
      setAddError(null)
    } catch (err) {
      setAddError((err as Error).message)
    }
  }

  async function handleDelete() {
    if (!confirmDel || delBusy) return
    setDelBusy(true)
    try {
      await deleteAccount(confirmDel)
      setConfirmDel(null)
      await loadAccounts()
    } catch (err) {
      setConfirmDel(null)
      setAccountsError((err as Error).message)
    } finally {
      setDelBusy(false)
    }
  }

  async function handleCreate() {
    if (createBusy) return
    if (!accountId) {
      setCreateError('先选一个账号')
      return
    }
    const name = repoName.trim()
    if (!name) {
      setCreateError('仓库名不能为空')
      return
    }

    setCreateBusy(true)
    setCreateError(null)
    try {
      const repo = await createRemoteRepo(accountId, {
        name,
        private: repoPrivate,
        description: repoDesc.trim(),
      })
      const url = repo.cloneUrl || repo.sshUrl
      if (!url) {
        setCreateError('仓库建好了，但没拿到 clone 地址，先去站点复制一下')
        return
      }
      pick(url)
    } catch (err) {
      setCreateError((err as Error).message)
    } finally {
      setCreateBusy(false)
    }
  }

  return (
    <div
      className="git-picker-layer"
      role="dialog"
      aria-modal="true"
      aria-label="设置远程仓库"
      onMouseDown={(event) => {
        // 点遮罩关闭；点卡片内部不算
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="git-picker-card">
        <div className="git-picker-head">
          <span className="git-picker-title">设置远程仓库</span>
          <button type="button" className="git-close" onClick={onClose} title="关闭">
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="git-account-bar">
          <span className="git-form-label">账号</span>
          {accounts === null ? (
            <span className="git-form-hint">{accountsBusy ? '正在读取账号…' : '还没有账号'}</span>
          ) : accounts.length === 0 ? (
            <span className="git-form-hint">还没有添加账号</span>
          ) : (
            <select
              className="git-account-select"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              disabled={accountsBusy}
            >
              {accounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {accountLabel(item)}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="git-account-add"
            onClick={() => {
              setAddOpen((prev) => !prev)
              setAddError(null)
            }}
          >
            {addOpen ? '收起' : '添加账号'}
          </button>
          {account ? (
            <button type="button" className="git-account-del" onClick={() => setConfirmDel(account.id)}>
              删除
            </button>
          ) : null}
        </div>

        {accountsError ? <div className="git-form-error git-picker-bar-error">{accountsError}</div> : null}

        {addOpen ? null : (
          <div className="git-picker-tabs">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`git-picker-tab${tab === item.key ? ' active' : ''}`}
                onClick={() => setTab(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        <div className="git-picker-body">
          {addOpen ? (
            <div className="git-add-account">
              <div className="git-form-row">
                <span className="git-form-label">类型</span>
                <select
                  className="git-form-input"
                  value={addKind}
                  onChange={(event) => {
                    const next = event.target.value as RemoteKind | ''
                    setAddKind(next)
                    setAddBaseUrl(next === 'github' ? 'https://github.com' : '')
                    // 换类型等于换站点，方式回到默认：GitHub 只能粘贴，其它默认一键登录
                    setAddMode(next === 'github' ? 'token' : 'login')
                  }}
                >
                  <option value="">自动识别</option>
                  <option value="github">GitHub</option>
                  <option value="gitea">Gitea</option>
                </select>
              </div>

              <div className="git-form-row">
                <span className="git-form-label">服务器</span>
                <input
                  className="git-form-input"
                  value={addBaseUrl}
                  onChange={(event) => setAddBaseUrl(event.target.value)}
                  placeholder="https://github.com 或 http://192.168.31.8:3000"
                  spellCheck={false}
                />
              </div>

              <div className="git-form-row">
                <span className="git-form-label">方式</span>
                <div className="git-login-mode" role="group" aria-label="登录方式">
                  <button
                    type="button"
                    className={`git-login-mode-btn${mode === 'login' ? ' active' : ''}`}
                    onClick={() => setAddMode('login')}
                    disabled={addBusy || githubLocked}
                    title={githubLocked ? 'GitHub 不支持账号密码登录' : undefined}
                  >
                    一键登录
                  </button>
                  <button
                    type="button"
                    className={`git-login-mode-btn${mode === 'token' ? ' active' : ''}`}
                    onClick={() => setAddMode('token')}
                    disabled={addBusy}
                  >
                    粘贴令牌
                  </button>
                </div>
              </div>

              {githubLocked ? <div className="git-login-note">GitHub 不支持账号密码登录</div> : null}

              {mode === 'login' ? (
                <>
                  <div className="git-form-row">
                    <span className="git-form-label">用户名</span>
                    <input
                      className="git-form-input"
                      value={addUsername}
                      onChange={(event) => setAddUsername(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void handleLogin()
                      }}
                      placeholder="Gitea 用户名"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </div>

                  <div className="git-form-row">
                    <span className="git-form-label">密码</span>
                    <div className="git-token-row">
                      <input
                        className="git-form-input"
                        type={showPassword ? 'text' : 'password'}
                        value={addPassword}
                        onChange={(event) => setAddPassword(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void handleLogin()
                        }}
                        placeholder="Gitea 密码"
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="git-token-toggle"
                        onClick={() => setShowPassword((prev) => !prev)}
                      >
                        {showPassword ? '隐藏' : '显示'}
                      </button>
                    </div>
                  </div>

                  <div className="git-pw-hint">密码只用来换一次令牌，不会保存</div>
                  <div className="git-form-hint">
                    用账号密码换一个访问令牌，换到就直接保存账号，不用去设置页手动生成。
                  </div>
                </>
              ) : (
                <>
                  <div className="git-form-row">
                    <span className="git-form-label">token</span>
                    <div className="git-token-row">
                      <input
                        className="git-form-input"
                        type={showToken ? 'text' : 'password'}
                        value={addToken}
                        onChange={(event) => setAddToken(event.target.value)}
                        placeholder="粘贴访问令牌"
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="git-token-toggle"
                        onClick={() => setShowToken((prev) => !prev)}
                      >
                        {showToken ? '隐藏' : '显示'}
                      </button>
                    </div>
                  </div>

                  {githubLocked ? (
                    <button
                      type="button"
                      className="git-token-page-btn"
                      onClick={() => void handleOpenTokenPage()}
                    >
                      打开令牌创建页
                    </button>
                  ) : null}

                  <div className="git-form-hint">
                    {addKind === 'gitea' ? GITEA_HINT : addKind === 'github' ? GITHUB_HINT : `${GITHUB_HINT}；${GITEA_HINT}`}
                  </div>
                </>
              )}

              {addError ? <div className="git-form-error">{addError}</div> : null}

              <div className="git-picker-actions">
                <button
                  type="button"
                  className="git-remote-cancel"
                  onClick={() => setAddOpen(false)}
                  disabled={addBusy}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="git-remote-save"
                  onClick={() => void (mode === 'login' ? handleLogin() : handleAdd())}
                  disabled={addBusy || (mode === 'login' && githubLocked)}
                >
                  {mode === 'login'
                    ? addBusy
                      ? '登录中…'
                      : '登录并获取令牌'
                    : addBusy
                      ? '验证中…'
                      : '验证并保存'}
                </button>
              </div>
            </div>
          ) : null}

          {!addOpen && tab === 'manual' ? (
            <>
              <div className="git-form-row">
                <span className="git-form-label">地址</span>
                <input
                  className="git-form-input"
                  value={manualUrl}
                  autoFocus
                  onChange={(event) => setManualUrl(event.target.value)}
                  placeholder="https://… 或 git@…"
                  spellCheck={false}
                />
              </div>
              <div className="git-form-hint">支持 https 和 ssh 地址；保存后会把 origin 指到这里。</div>
              {manualError ? <div className="git-form-error">{manualError}</div> : null}
              <div className="git-picker-actions">
                <button type="button" className="git-remote-save" onClick={handleManual}>
                  使用这个地址
                </button>
              </div>
            </>
          ) : null}

          {!addOpen && tab === 'repos' ? (
            noAccount ? (
              <div className="git-empty">还没有添加账号，先在右上角点「添加账号」</div>
            ) : (
              <>
                <div className="git-picker-row">
                  <input
                    className="git-form-input"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索仓库名"
                    spellCheck={false}
                  />
                </div>

                {reposError ? <div className="git-form-error">{reposError}</div> : null}

                <div className="git-repo-list">
                  {repos === null ? (
                    <div className="git-empty">{reposBusy ? '正在读取仓库…' : '还没有读到仓库'}</div>
                  ) : repos.length === 0 ? (
                    <div className="git-empty">没有匹配的仓库</div>
                  ) : (
                    repos.map((repo) => (
                      <div className="git-repo-row" key={repo.fullName}>
                        <span className="git-repo-name" title={repo.fullName}>
                          {repo.fullName}
                        </span>
                        {repo.private ? <span className="git-repo-tag">私有</span> : null}
                        {repo.empty ? <span className="git-repo-empty">空仓库</span> : null}
                        <button type="button" className="git-repo-use" onClick={() => handleUseRepo(repo)}>
                          用这个
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </>
            )
          ) : null}

          {!addOpen && tab === 'create' ? (
            noAccount ? (
              <div className="git-empty">还没有添加账号，先在右上角点「添加账号」</div>
            ) : (
              <>
                <div className="git-form-row">
                  <span className="git-form-label">名字</span>
                  <input
                    className="git-form-input"
                    value={repoName}
                    onChange={(event) => setRepoName(event.target.value)}
                    placeholder="repo"
                    spellCheck={false}
                  />
                </div>

                <label className="git-form-row git-picker-check">
                  <input
                    type="checkbox"
                    checked={repoPrivate}
                    onChange={(event) => setRepoPrivate(event.target.checked)}
                  />
                  <span className="git-form-label">私有仓库</span>
                </label>

                <div className="git-form-row">
                  <span className="git-form-label">描述</span>
                  <input
                    className="git-form-input"
                    value={repoDesc}
                    onChange={(event) => setRepoDesc(event.target.value)}
                    placeholder="可选"
                    spellCheck={false}
                  />
                </div>

                {createError ? <div className="git-form-error">{createError}</div> : null}

                <div className="git-picker-actions">
                  <button
                    type="button"
                    className="git-remote-save"
                    onClick={() => void handleCreate()}
                    disabled={createBusy}
                  >
                    {createBusy ? '创建中…' : '创建并使用'}
                  </button>
                </div>
              </>
            )
          ) : null}
        </div>

        {confirmDel ? (
          <div className="git-confirm-layer" role="dialog" aria-modal="true">
            <div className="git-confirm-card">
              <div className="git-confirm-title">删除这个账号？</div>
              <div className="git-confirm-text">
                {account ? accountLabel(account) : confirmDel}
              </div>
              <div className="git-confirm-note">
                只删本地保存的账号和 token，远程仓库和已经推送的内容都不受影响。
              </div>
              <div className="git-confirm-actions">
                <button
                  type="button"
                  className="git-confirm-hard"
                  onClick={() => void handleDelete()}
                  disabled={delBusy}
                >
                  {delBusy ? '删除中…' : '删除'}
                </button>
                <button
                  type="button"
                  className="git-confirm-cancel"
                  onClick={() => setConfirmDel(null)}
                  disabled={delBusy}
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
