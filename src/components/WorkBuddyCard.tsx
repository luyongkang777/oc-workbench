import { useCallback, useEffect, useRef, useState } from 'react'
import { withBase } from '../api/base'
import {
  claimWorkBuddyCheckin,
  getWorkBuddyBilling,
  getWorkBuddyStatus,
  logoutWorkBuddy,
  pollWorkBuddyLogin,
  startWorkBuddyLogin,
  type WorkBuddyBilling,
  type WorkBuddyStatus,
} from '../api/workbuddy'
import type { ProviderController } from '../hooks/useProviderPanel'
import { WORKBUDDY_PRESET } from './providerForm'
import workbuddyIcon from '../assets/providers/workbuddy.svg'

/** 令牌轮询间隔：腾讯那边登录一完成就能拿到。 */
const POLL_MS = 1200
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

function openExternal(url: string) {
  const w = window as unknown as { ipc?: { postMessage(message: string): void } }
  if (w.ipc?.postMessage) {
    w.ipc.postMessage(`oc:open-url:${url}`)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

type Props = {
  controller: ProviderController
  /** 面板开着才轮询 */
  open: boolean
}

/**
 * WorkBuddy 卡片：和其它三个预设并排，不再单独占一个板块。
 *
 * 点击行为：
 *   - 未登录 → 打开腾讯登录页（工作台自己完成，不经过 Magpie）
 *   - 已登录 → 把本地转发地址与模型填进下面的表单
 *
 * 卡片副标题显示积分与签到状态；打开面板时会 **自动签到**（今天没签的话）。
 */
export default function WorkBuddyCard({ controller, open }: Props) {
  const [status, setStatus] = useState<WorkBuddyStatus | null>(null)
  const [billing, setBilling] = useState<WorkBuddyBilling | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | null>(null)
  const deadline = useRef(0)
  const alive = useRef(true)

  const stop = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      stop()
    }
  }, [stop])

  const load = useCallback(async (refresh = false) => {
    try {
      const fresh = await getWorkBuddyStatus()
      if (!alive.current) return
      setStatus(fresh)
      if (!fresh.configured) {
        if (alive.current) setBilling(null)
        return
      }
      // 打开面板/刷新时带 auto=1：今天没签到就顺手签了
      const money = await getWorkBuddyBilling(!refresh, refresh)
      if (!alive.current) return
      setBilling(money)
      setError(money.ok ? null : (money.error ?? null))
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : '读不到 WorkBuddy 状态')
    }
  }, [])

  useEffect(() => {
    if (!open) {
      stop()
      return
    }
    void load(false)
  }, [open, load, stop])

  const poll = useCallback(
    async (state: string) => {
      try {
        const result = await pollWorkBuddyLogin(state)
        if (!alive.current) return
        if (result.done) {
          setRunning(false)
          setError(null)
          await load(true)
          return
        }
        if (result.error) {
          setRunning(false)
          setError(result.error)
          return
        }
        if (Date.now() > deadline.current) {
          setRunning(false)
          setError('登录超时了，再点一次')
          return
        }
        timer.current = window.setTimeout(() => void poll(state), POLL_MS)
      } catch (err) {
        if (!alive.current) return
        setRunning(false)
        setError(err instanceof Error ? err.message : '轮询登录状态失败')
      }
    },
    [load],
  )

  const start = useCallback(async () => {
    if (running) return
    setError(null)
    stop()
    try {
      const started = await startWorkBuddyLogin()
      if (!started.ok || !started.state || !started.url) {
        setError(started.error || 'WorkBuddy 没有给出登录页')
        return
      }
      openExternal(started.url)
      setRunning(true)
      deadline.current = Date.now() + LOGIN_TIMEOUT_MS
      timer.current = window.setTimeout(() => void poll(started.state as string), POLL_MS)
    } catch (err) {
      setError(err instanceof Error ? err.message : '开始登录失败')
    }
  }, [poll, running, stop])

  const quit = useCallback(async () => {
    stop()
    setRunning(false)
    setError(null)
    try {
      const fresh = await logoutWorkBuddy()
      if (!alive.current) return
      setStatus(fresh)
      setBilling(null)
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : '退出登录失败')
    }
  }, [stop])

  const checkin = useCallback(async () => {
    try {
      const result = await claimWorkBuddyCheckin()
      if (!alive.current) return
      if (!result.ok) {
        setError(result.error || '签到失败')
        return
      }
      if (result.billing) setBilling(result.billing)
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : '签到失败')
    }
  }, [])

  const connect = useCallback(async () => {
    if (!status?.configured) return
    const baseURL = `${window.location.origin}${withBase(status.path)}`
    await controller.connectPreset({ ...WORKBUDDY_PRESET, baseURL, apiKey: status.apiKey }, '')
  }, [controller, status])

  const configured = status?.configured === true
  const total = billing?.credits?.total ?? 0
  const streak = billing?.checkin?.streakDays ?? 0
  const checked = billing?.checkin?.todayCheckedIn === true
  const who = status?.account || status?.uid || ''

  const primary = () => {
    if (running || controller.busy) return
    if (configured) void connect()
    else void start()
  }

  let subtitle = '未登录 · 点一下登录'
  if (running) subtitle = '等待浏览器登录…'
  else if (configured) {
    const parts = [`积分 ${formatCredits(total)}`]
    if (streak > 0) parts.push(`连续 ${streak} 天`)
    parts.push(checked ? '今日已签' : '今日未签')
    subtitle = parts.join(' · ')
  }

  return (
    <div
      className={`provider-preset provider-wb-card${configured ? ' active' : ''}`}
      role="button"
      tabIndex={0}
      title={error ?? (configured ? `已登录${who ? `：${who}` : ''}，点击接入` : '点击登录 WorkBuddy')}
      onClick={primary}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          primary()
        }
      }}
    >
      <img className="provider-icon" src={workbuddyIcon} alt="" />
      <span className="provider-preset-text">
        <span className="provider-preset-name">WorkBuddy</span>
        <span className="provider-preset-url">{subtitle}</span>
      </span>
      <span className="provider-wb-btns">
        <span
          role="button"
          tabIndex={0}
          className="provider-wb-btn"
          title="刷新积分与签到状态"
          onClick={(event) => {
            event.stopPropagation()
            void load(true)
          }}
        >
          刷新
        </span>
        {configured && !checked ? (
          <span
            role="button"
            tabIndex={0}
            className="provider-wb-btn"
            title="立即签到"
            onClick={(event) => {
              event.stopPropagation()
              void checkin()
            }}
          >
            签到
          </span>
        ) : null}
        {configured ? (
          <span
            role="button"
            tabIndex={0}
            className="provider-wb-btn"
            title="退出 WorkBuddy 登录"
            onClick={(event) => {
              event.stopPropagation()
              void quit()
            }}
          >
            退出
          </span>
        ) : null}
      </span>
    </div>
  )
}

/** 积分可能带小数（活动积分通常是整数），最多两位。 */
function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}
