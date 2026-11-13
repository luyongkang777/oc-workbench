import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getAuthState, subscribeAuth } from '../api/auth'
import { Icon } from './Icon'
import {
  applyUpdate,
  checkUpdate,
  getUpdateConfig,
  saveUpdateSource,
  setAutoCheck,
  skipUpdate,
} from '../api/update'
import type { UpdateCheck } from '../api/update'

type Phase = 'checking' | 'ready' | 'applying' | 'restarting'

/** 顶栏提示点要不要亮：有新版本且用户没跳过它。 */
function badgeOf(result: UpdateCheck): string | null {
  return result.newer && !result.skipped && result.latest ? result.latest : null
}

function formatSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 顶栏入口：版本号 + 有新版时的一颗提示点。
 *
 * 检查逻辑放在这一层而不是弹窗里：弹窗关掉会卸载，检查结果（有没有新版）
 * 需要留在按钮上，否则每次都要重新检查才知道。
 */
export default function UpdateEntry({ version }: { version: string }) {
  const [open, setOpen] = useState(false)
  const [latest, setLatest] = useState<string | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /**
   * 启动后的静默检查：只在开着「自动检查」时做。
   *
   * 先读一次配置再决定要不要发请求——关掉之后连这一次外联都不该有。
   * 配置读不到就按默认（开）走，别因为一个本地接口失败就静默失去更新能力。
   */
  // 令牌是页面挂载后才经 IPC 下发的：还没 ready 就发 /local/* 会 403，
  // 于是「读不到配置」的兜底会把关掉的自动检查又打开。必须等握手完成。
  const auth = useSyncExternalStore(subscribeAuth, getAuthState)

  useEffect(() => {
    if (auth.status !== 'ready') return
    let cancelled = false
    let timer = 0
    const scheduleSilent = () => {
      timer = window.setTimeout(() => {
        checkUpdate()
          .then((result) => {
            if (!cancelled && alive.current) setLatest(badgeOf(result))
          })
          .catch(() => {
            // 没配更新源、或者暂时连不上：不打扰，点开面板才看细节
          })
      }, 4000)
    }
    getUpdateConfig()
      .then((config) => {
        if (!cancelled && config.autoCheck) scheduleSilent()
      })
      .catch(() => {
        if (!cancelled) scheduleSilent()
      })
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [auth.status])

  return (
    <div className="update-entry">
      <button
        type="button"
        className={`update-chip${latest ? ' fresh' : ''}`}
        title={latest ? `有新版本 v${latest}` : '检查更新'}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="download" size={12} />
        <span>v{version}</span>
        {latest ? <span className="update-dot" /> : null}
      </button>
      {open ? (
        <UpdateDialog
          version={version}
          onClose={() => setOpen(false)}
          onResult={(result) => setLatest(badgeOf(result))}
        />
      ) : null}
    </div>
  )
}

function UpdateDialog({
  version,
  onClose,
  onResult,
}: {
  version: string
  onClose: () => void
  onResult: (result: UpdateCheck) => void
}) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [info, setInfo] = useState<UpdateCheck | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState('')
  const [savingSource, setSavingSource] = useState(false)
  // 有内置默认源，面板默认只读显示；想换成镜像/私服时点「更改」再展开输入框
  const [editingSource, setEditingSource] = useState(false)
  // 开关的本地值：点一下立刻反映，落盘失败再回滚
  const [localAuto, setLocalAuto] = useState<boolean | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const runCheck = useCallback(async () => {
    setPhase('checking')
    setError(null)
    try {
      const result = await checkUpdate()
      if (!alive.current) return
      setInfo(result)
      setSource(result.source ?? '')
      setError(result.error)
      setPhase('ready')
      onResult(result)
    } catch (err) {
      if (!alive.current) return
      setError((err as Error).message)
      setPhase('ready')
    }
  }, [onResult])

  useEffect(() => {
    void runCheck()
  }, [runCheck])

  // Esc 关闭；更新进行中不关（关了也拦不住进程退出，只会让人误以为失败）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (phase === 'applying' || phase === 'restarting') return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, phase])

  /** 跳过这个版本（只影响提示，不阻止手动更新）。 */
  async function skipThis(version: string) {
    try {
      await skipUpdate(version)
      await runCheck()
    } catch (err) {
      if (alive.current) setError((err as Error).message)
    }
  }

  /** 取消跳过：清掉记录后重新检查。 */
  async function unskip() {
    try {
      await skipUpdate('')
      await runCheck()
    } catch (err) {
      if (alive.current) setError((err as Error).message)
    }
  }

  /** 开/关启动时自动检查。 */
  async function toggleAuto(enabled: boolean) {
    setLocalAuto(enabled)
    try {
      await setAutoCheck(enabled)
    } catch (err) {
      if (alive.current) {
        setLocalAuto(null) // 落盘失败就回到服务端的真值
        setError((err as Error).message)
      }
    }
  }

  async function saveSource() {
    if (savingSource) return
    setSavingSource(true)
    setError(null)
    try {
      await saveUpdateSource(source.trim())
      setEditingSource(false)
      await runCheck()
    } catch (err) {
      if (alive.current) setError((err as Error).message)
    } finally {
      if (alive.current) setSavingSource(false)
    }
  }

  async function startUpdate() {
    if (phase === 'applying' || phase === 'restarting') return
    setPhase('applying')
    setError(null)
    try {
      await applyUpdate()
      if (!alive.current) return
      setPhase('restarting')
    } catch (err) {
      if (!alive.current) return
      setError((err as Error).message)
      setPhase('ready')
    }
  }

  const current = info?.current ?? version
  const latest = info?.latest ?? null
  const configured = info?.configured ?? true
  const isSkipped = info?.skipped ?? false
  const autoCheck = localAuto ?? info?.autoCheck ?? true
  const busy = phase === 'checking' || phase === 'applying' || phase === 'restarting'

  return (
    <div className="update-mask" role="presentation" onClick={() => (busy ? undefined : onClose())}>
      <div
        className="update-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="版本与更新"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="update-head">
          <span className="update-title">版本与更新</span>
          <button
            type="button"
            className="update-close"
            onClick={onClose}
            disabled={phase === 'applying' || phase === 'restarting'}
            title="关闭"
            aria-label="关闭"
          >
            <Icon name="close" size={13} />
          </button>
        </header>

        <div className="update-body">
          <div className="update-row">
            <span className="update-label">当前版本</span>
            <span className="update-value">v{current}</span>
          </div>

          {latest ? (
            <div className="update-row">
              <span className="update-label">最新版本</span>
              <span className={`update-value${info?.newer ? ' fresh' : ''}`}>
                v{latest}
                {info?.newer ? (isSkipped ? '（已跳过）' : '（可更新）') : '（已是最新）'}
                {formatSize(info?.size ?? 0) ? ` · ${formatSize(info?.size ?? 0)}` : ''}
              </span>
            </div>
          ) : null}

          {info?.newer && latest && phase === 'ready' ? (
            <div className="update-skiprow">
              {isSkipped ? (
                <button type="button" className="update-link" onClick={() => void unskip()}>
                  取消跳过（恢复提示）
                </button>
              ) : (
                <button type="button" className="update-link" onClick={() => void skipThis(latest)}>
                  跳过这个版本
                </button>
              )}
              {isSkipped ? <span className="update-skipnote">顶栏不会再提示，仍可随时更新</span> : null}
            </div>
          ) : null}

          {info?.notes ? <div className="update-notes">{info.notes}</div> : null}
          {error ? <div className="update-error">{error}</div> : null}

          {phase === 'checking' ? <div className="update-hint">正在检查…</div> : null}
          {phase === 'applying' ? (
            <div className="update-hint">正在下载并校验，完成后窗口会自动重启…</div>
          ) : null}
          {phase === 'restarting' ? (
            <div className="update-hint ready">更新包已就绪，正在重启到新版本…</div>
          ) : null}

          {(!configured || editingSource) && phase !== 'applying' ? (
            <div className="update-source">
              <div className="update-source-title">
                {configured ? '更换更新源' : '还没有配置更新源'}
              </div>
              <div className="update-source-hint">
                填一份 latest.json 的地址（http/https）。默认走 GitHub Release，
                只有点检查或更新时才会访问它；留空表示不检查更新。
              </div>
              <div className="update-source-row">
                <input
                  className="update-input"
                  value={source}
                  placeholder="https://github.com/<user>/<repo>/releases/latest/download/latest.json"
                  onChange={(event) => setSource(event.target.value)}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="update-btn"
                  onClick={() => void saveSource()}
                  disabled={savingSource || !source.trim()}
                >
                  {savingSource ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          ) : null}

          <label className="update-auto">
            <input
              type="checkbox"
              checked={autoCheck}
              disabled={busy}
              onChange={(event) => void toggleAuto(event.target.checked)}
            />
            <span className="update-auto-title">启动时自动检查更新</span>
            <span className="update-auto-hint">
              {autoCheck ? '启动约 4 秒后静默检查一次' : '只在点开这个面板时检查'}
            </span>
          </label>

          {configured && info?.source && phase === 'ready' && !editingSource ? (
            <div className="update-source-now" title={info.source}>
              <span className="update-source-url">更新源：{info.source}</span>
              <button
                type="button"
                className="update-link"
                onClick={() => {
                  setSource(info.source ?? '')
                  setEditingSource(true)
                }}
              >
                更改
              </button>
            </div>
          ) : null}
        </div>

        <footer className="update-actions">
          <button type="button" className="update-btn" onClick={() => void runCheck()} disabled={busy}>
            {phase === 'checking' ? '检查中…' : '检查更新'}
          </button>
          <span className="update-spacer" />
          <button
            type="button"
            className="update-btn primary"
            onClick={() => void startUpdate()}
            disabled={busy || !info?.newer}
            title={info?.newer ? `更新到 v${latest}` : '没有可用更新'}
          >
            {phase === 'applying' ? '下载中…' : phase === 'restarting' ? '重启中…' : '立即更新'}
          </button>
        </footer>
      </div>
    </div>
  )
}
