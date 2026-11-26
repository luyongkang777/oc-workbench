import { useCallback, useEffect, useRef, useState } from 'react'
import { bindCreate, bindPoll, type MaxiBindTicket } from '../api/maxi'

const POLL_MS = 1500

type Props = {
  open: boolean
  onClose: () => void
  /** 绑定成功（已经落盘登录态） */
  onDone: () => void
}

/**
 * 扫码绑定：工作台自己出二维码，手机微信扫一下就完成，不需要装码栖客户端。
 *
 * 二维码内容由外壳生成（`maxi-pc-bind` JSON），这里只负责显示和轮询。
 */
export default function MaxiBindModal({ open, onClose, onDone }: Props) {
  const [ticket, setTicket] = useState<MaxiBindTicket | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'waiting' | 'done' | 'expired'>('loading')
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

  const poll = useCallback(
    async (tk: string, pk: string) => {
      try {
        const result = await bindPoll(tk, pk)
        if (!alive.current) return
        if (result.ok && result.status === 'confirmed') {
          setStatus('done')
          stop()
          window.setTimeout(() => {
            if (alive.current) onDone()
          }, 600)
          return
        }
        if (result.ok && result.status === 'expired') {
          setStatus('expired')
          setError('二维码过期了，点「重新生成」')
          return
        }
        if (!result.ok) {
          setError(result.error || '轮询失败')
        }
        if (Date.now() > deadline.current) {
          setStatus('expired')
          setError('二维码过期了，点「重新生成」')
          return
        }
        timer.current = window.setTimeout(() => void poll(tk, pk), POLL_MS)
      } catch (err) {
        if (!alive.current) return
        setError(err instanceof Error ? err.message : '轮询失败')
        if (Date.now() < deadline.current) {
          timer.current = window.setTimeout(() => void poll(tk, pk), POLL_MS * 2)
        }
      }
    },
    [onDone, stop],
  )

  const start = useCallback(async () => {
    stop()
    setError(null)
    setTicket(null)
    setStatus('loading')
    try {
      const fresh = await bindCreate()
      if (!alive.current) return
      if (!fresh.ok || !fresh.ticket || !fresh.pollKey || !fresh.qr) {
        setStatus('expired')
        setError(fresh.error || '生成二维码失败')
        return
      }
      setTicket(fresh)
      setStatus('waiting')
      const ttl = (fresh.expiresInSeconds || 180) * 1000
      deadline.current = Date.now() + ttl
      timer.current = window.setTimeout(() => void poll(fresh.ticket as string, fresh.pollKey as string), POLL_MS)
    } catch (err) {
      if (alive.current) {
        setStatus('expired')
        setError(err instanceof Error ? err.message : '生成二维码失败')
      }
    }
  }, [poll, stop])

  useEffect(() => {
    if (!open) {
      stop()
      return
    }
    void start()
  }, [open, start, stop])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div className="provider-mask open" onClick={onClose} />
      <div
        role="dialog"
        aria-label="扫码绑定码栖"
        style={{
          position: 'fixed',
          zIndex: 61,
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 360,
          background: 'var(--panel, #fff)',
          border: '1px solid var(--border, #d9d9d9)',
          borderRadius: 10,
          padding: 20,
          boxShadow: '0 12px 40px rgba(0,0,0,.18)',
          textAlign: 'center',
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>扫码绑定码栖</div>
        <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 14 }}>
          用微信扫一下，绑定这台电脑即可。不需要装码栖客户端。
        </div>

        <div
          style={{
            width: 240,
            height: 240,
            margin: '0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#fff',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          {ticket?.qr ? (
            <img src={ticket.qr} alt="绑定二维码" width={240} height={240} />
          ) : (
            <span style={{ fontSize: 12, opacity: 0.6 }}>生成中…</span>
          )}
        </div>

        <div style={{ marginTop: 12, fontSize: 12, minHeight: 18, opacity: 0.8 }}>
          {status === 'done' ? '已绑定，正在刷新…' : status === 'expired' ? error : '等待扫码确认…'}
        </div>
        {status !== 'expired' && error ? (
          <div style={{ marginTop: 4, fontSize: 12, color: '#c0392b' }}>{error}</div>
        ) : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
          <button type="button" className="provider-btn" onClick={() => void start()}>
            重新生成
          </button>
          <button type="button" className="provider-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </>
  )
}
