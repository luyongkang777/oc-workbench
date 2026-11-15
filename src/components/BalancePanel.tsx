import { useCallback, useEffect, useRef, useState } from 'react'

import {
  clearBalanceKey,
  detectMagpieKey,
  fetchBalanceStatus,
  saveBalanceKey,
  type BalanceStatus,
} from '../api/balance'
import { formatBalance } from './balanceFormat'
import type { DeepSeekBalance } from '../api/balance'

/**
 * 余额面板：查余额、填密钥、从 magpie 自动读取、去充值。
 *
 * 为什么只有「去官方充值」而不是内联支付：DeepSeek 官方没有公开的充值/支付接口，
 * 支付宝、微信支付都必须在其充值页扫码完成（还要过风控）。所以这里做到的是
 * 「选好金额 → 一键送到官方充值页」，省掉记网址、登录、找入口这几步；
 * 付完回来点「刷新余额」立刻能看到新数字。
 *
 * key 永远不回显：状态接口只给掩码（`sk-9fc…e0ff`）。
 */
const TOP_UP_URL = 'https://platform.deepseek.com/top_up'
const AMOUNT_PRESETS = [10, 50, 100, 200]

type Props = {
  open: boolean
  onClose: () => void
  /** 余额或密钥变化后通知顶栏胶囊重新取一次。 */
  onChanged: () => void
  /** 顶栏胶囊当前持有的余额结果，用来在面板顶部直接复述。 */
  snapshot: DeepSeekBalance | null
  onRefresh: () => void
  refreshing: boolean
}

type Message = { tone: 'ok' | 'bad'; text: string }

function openExternal(url: string) {
  const w = window as unknown as { ipc?: { postMessage(message: string): void } }
  if (w.ipc?.postMessage) {
    w.ipc.postMessage(`oc:open-url:${url}`)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** 同步复制：WebView2 里这条路最稳，不依赖焦点权限。 */
function copySync(text: string): boolean {
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/**
 * 复制文本。
 *
 * **只用同步的 execCommand**：`navigator.clipboard.writeText` 在 WebView2 里会触发
 * `edge://permission-request-dialog`，把整个工作台页面顶掉（实测点一次「复制金额」
 * 就直接白屏停在权限对话框）。复制失败也只是一句提示，绝不能为此换页面。
 */
function copyText(text: string): boolean {
  return copySync(text)
}

export default function BalancePanel(props: Props) {
  const { open, onClose, onChanged, snapshot, onRefresh, refreshing } = props
  const [status, setStatus] = useState<BalanceStatus | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [amount, setAmount] = useState('50')
  const [channel, setChannel] = useState<'alipay' | 'wechat'>('alipay')

  const loadStatus = useCallback(async () => {
    setStatus(await fetchBalanceStatus())
  }, [])

  // onClose 每次父组件渲染都可能换新函数，放进依赖会让 effect 重跑、
  // 把刚显示的操作结果清掉（实测「从 magpie 读取」的成功提示会被吃掉）。
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    setMessage(null)
    void loadStatus()
    // 打开面板多半就是为了看最新数字（尤其刚充完钱）：先强制查一次。
    onRefresh()
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, loadStatus, onRefresh])

  // 面板开着时每 8 秒自动刷一次：充值到账往往要等十几秒，
  // 让用户盯着数字自己跳出来，不用反复点「刷新」。
  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => onRefresh(), 8000)
    return () => window.clearInterval(timer)
  }, [open, onRefresh])

  const view = formatBalance(snapshot)
  const amountValue = Number(amount)
  const amountValid = Number.isFinite(amountValue) && amountValue > 0 && amountValue <= 100000

  /** 返回是否成功：调用方据此决定要不要清空输入框 / 刷新余额。 */
  async function run(
    action: () => Promise<{ ok: boolean; status?: BalanceStatus; error?: string }>,
    okText: string,
  ): Promise<boolean> {
    setBusy(true)
    setMessage(null)
    try {
      const result = await action()
      if (result.ok && result.status) {
        setStatus(result.status)
        setMessage({ tone: 'ok', text: okText })
        onChanged()
        return true
      }
      setMessage({ tone: 'bad', text: result.error || '操作失败' })
      return false
    } finally {
      setBusy(false)
    }
  }

  async function handleSave() {
    const key = keyInput.trim()
    if (!key) {
      setMessage({ tone: 'bad', text: '先把 sk 粘进来' })
      return
    }
    // 只有真的存下去了才清空：校验失败/网络错误时要让用户改一改重试，
    // 不能把他刚粘进来的 key 抹掉。
    if (await run(() => saveBalanceKey(key), '已保存，余额马上刷新')) {
      setKeyInput('')
    }
  }

  async function handleCopyAmount() {
    if (!amountValid) {
      setMessage({ tone: 'bad', text: '金额要填一个正数' })
      return
    }
    const ok = copyText(amountValue.toFixed(2))
    setMessage(
      ok
        ? { tone: 'ok', text: `已复制 ${amountValue.toFixed(2)}，粘到官方充值页的金额框里` }
        : { tone: 'bad', text: `复制失败，手动填 ${amountValue.toFixed(2)} 即可` },
    )
  }

  function handleTopUp() {
    if (!amountValid) {
      setMessage({ tone: 'bad', text: '金额要填一个正数' })
      return
    }
    setMessage({
      tone: 'ok',
      text: `已打开官方充值页：选 ${channelLabel(channel)}、金额填 ${amountValue.toFixed(2)}，扫码支付后回来点「刷新余额」`,
    })
    openExternal(TOP_UP_URL)
  }

  return (
    <>
      {open ? <div className="balance-mask" onMouseDown={onClose} /> : null}
      <aside className={`balance-panel${open ? ' open' : ''}`} aria-hidden={!open}>
        <div className="balance-head">
          <span className="balance-title">DeepSeek 余额</span>
          <button type="button" className="balance-close" onClick={onClose} aria-label="关闭余额面板">
            ×
          </button>
        </div>

        <div className="balance-body">
          <section className="balance-section">
            <div className={`balance-now ${view.tone}`}>
              <span className="balance-now-value">{view.text}</span>
              <button
                type="button"
                className="balance-btn ghost"
                onClick={() => {
                  onRefresh()
                  void loadStatus()
                }}
                disabled={refreshing}
              >
                {refreshing ? '刷新中…' : '刷新'}
              </button>
            </div>
            <p className="balance-hint">{view.title}</p>
          </section>

          <section className="balance-section">
            <h3 className="balance-section-title">密钥</h3>
            <p className="balance-hint">
              {status?.configured
                ? `当前：${status.masked}（来源：${sourceLabel(status.source)}）`
                : '还没有可用的官方密钥，填一个或用下面的「从 magpie 读取」'}
            </p>
            <div className="balance-row">
              <input
                className="balance-input"
                type="password"
                placeholder="sk-..."
                value={keyInput}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setKeyInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleSave()
                }}
              />
              <button
                type="button"
                className="balance-btn primary"
                onClick={() => void handleSave()}
                disabled={busy}
              >
                保存
              </button>
            </div>
            <div className="balance-row">
              <button
                type="button"
                className="balance-btn ghost"
                onClick={() => void run(detectMagpieKey, '已从 magpie 读取官方密钥')}
                disabled={busy || status?.hasMagpie === false}
                title={
                  status?.hasMagpie
                    ? `magpie 里的官方 key：${status.magpieMasked}`
                    : 'magpie 配置里没有 id=deepseek 的官方 key'
                }
              >
                从 magpie 读取
              </button>
              <button
                type="button"
                className="balance-btn ghost danger"
                onClick={() => void run(clearBalanceKey, '已清除保存的密钥')}
                disabled={busy || !status?.configured || status?.source !== 'settings'}
                title={status?.source === 'env' ? '当前用的是环境变量，清不掉' : '删除 settings.json 里保存的 key'}
              >
                清除
              </button>
            </div>
            {message ? <p className={`balance-msg ${message.tone}`}>{message.text}</p> : null}
          </section>

          <section className="balance-section">
            <h3 className="balance-section-title">充值</h3>
            <div className="balance-presets">
              {AMOUNT_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`balance-preset${amount === String(preset) ? ' active' : ''}`}
                  onClick={() => setAmount(String(preset))}
                >
                  {preset} 元
                </button>
              ))}
            </div>
            <div className="balance-row">
              <input
                className="balance-input"
                type="number"
                min={1}
                max={100000}
                step={1}
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                aria-label="充值金额（元）"
              />
              <span className="balance-unit">元</span>
            </div>
            <div className="balance-presets">
              <button
                type="button"
                className={`balance-preset${channel === 'alipay' ? ' active' : ''}`}
                onClick={() => setChannel('alipay')}
              >
                支付宝
              </button>
              <button
                type="button"
                className={`balance-preset${channel === 'wechat' ? ' active' : ''}`}
                onClick={() => setChannel('wechat')}
              >
                微信
              </button>
            </div>
            <div className="balance-row">
              <button type="button" className="balance-btn ghost" onClick={() => void handleCopyAmount()}>
                复制金额
              </button>
              <button type="button" className="balance-btn primary" onClick={handleTopUp}>
                去官方充值
              </button>
            </div>
            <p className="balance-hint">
              官方没有开放的充值接口，支付宝/微信支付只能在其充值页扫码完成。这里负责把你送到
              那一步（金额和渠道已选好，页面里照着填），付完回来点「刷新余额」。
            </p>
          </section>
        </div>
      </aside>
    </>
  )
}

function sourceLabel(source: BalanceStatus['source']): string {
  if (source === 'settings') return '设置文件'
  if (source === 'env') return '环境变量'
  return '未配置'
}

function channelLabel(channel: 'alipay' | 'wechat'): string {
  return channel === 'alipay' ? '支付宝' : '微信'
}
