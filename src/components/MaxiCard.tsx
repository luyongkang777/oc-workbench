import { useCallback, useEffect, useState } from 'react'
import { withBase } from '../api/base'
import { getMaxiStatus, importMaxi, logoutMaxi, type MaxiStatus } from '../api/maxi'
import type { ProviderController } from '../hooks/useProviderPanel'
import { MAXI_PRESET } from './providerForm'
import MaxiBindModal from './MaxiBindModal'
import maxiIcon from '../assets/providers/maxi.png'

type Props = {
  controller: ProviderController
  /** 面板开着才读状态 */
  open: boolean
}

/**
 * 码栖通道卡片：和 WorkBuddy 并排。
 *
 * 两种接入方式：
 *   - 本机装过码栖客户端 → 点一下直接读登录态（DPAPI 解密，不用手抄令牌）
 *   - 没装 → 弹二维码，手机微信扫一下，工作台自己注册设备
 */
export default function MaxiCard({ controller, open }: Props) {
  const [status, setStatus] = useState<MaxiStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bindOpen, setBindOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const fresh = await getMaxiStatus()
      setStatus(fresh)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不到码栖通道状态')
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  const connect = useCallback(async () => {
    if (!status) return
    const baseURL = `${window.location.origin}${withBase(status.path)}`
    await controller.connectPreset({ ...MAXI_PRESET, baseURL, apiKey: status.apiKey }, '')
  }, [controller, status])

  const importNow = useCallback(async () => {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      const result = await importMaxi()
      if (!result.ok) {
        setError(result.error || '导入失败')
        return
      }
      if (result.status) setStatus(result.status)
      else await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败')
    } finally {
      setBusy(false)
    }
  }, [busy, load])

  const quit = useCallback(async () => {
    setError(null)
    try {
      const fresh = await logoutMaxi()
      setStatus(fresh)
    } catch (err) {
      setError(err instanceof Error ? err.message : '退出失败')
    }
  }, [])

  const configured = status?.configured === true
  const available = status?.available === true

  const primary = () => {
    if (busy || controller.busy) return
    if (configured) void connect()
    else if (available) void importNow()
    else setBindOpen(true)
  }

  const onBound = useCallback(async () => {
    setBindOpen(false)
    await load()
  }, [load])

  let subtitle = '未接入 · 点一下扫码或导入'
  if (busy) subtitle = '正在导入…'
  else if (configured) {
    const who = status?.deviceName || status?.deviceId || ''
    const model = status?.model || 'gpt-6.2-sol'
    subtitle = who ? `${model} · ${who}` : model
  } else if (available) {
    subtitle = '检测到本机客户端 · 点一下导入'
  }

  return (
    <>
      <div
        className={`provider-preset provider-wb-card${configured ? ' active' : ''}`}
        role="button"
        tabIndex={0}
        title={error ?? subtitle}
        onClick={primary}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            primary()
          }
        }}
      >
        <img className="provider-icon" src={maxiIcon} alt="" />
        <span className="provider-preset-text">
          <span className="provider-preset-name">码栖官方</span>
          <span className="provider-preset-url">{subtitle}</span>
        </span>
        <span className="provider-wb-btns">
          {!configured ? (
            <span
              role="button"
              tabIndex={0}
              className="provider-wb-btn"
              title="用微信扫码绑定这台电脑"
              onClick={(event) => {
                event.stopPropagation()
                setBindOpen(true)
              }}
            >
              扫码
            </span>
          ) : null}
          {configured ? (
            <span
              role="button"
              tabIndex={0}
              className="provider-wb-btn"
              title="把本地转发地址与模型填进表单"
              onClick={(event) => {
                event.stopPropagation()
                void connect()
              }}
            >
              接入
            </span>
          ) : null}
          {configured ? (
            <span
              role="button"
              tabIndex={0}
              className="provider-wb-btn"
              title="清掉本机导入的登录态"
              onClick={(event) => {
                event.stopPropagation()
                void quit()
              }}
            >
              退出
            </span>
          ) : null}
        </span>
        {error ? <span className="provider-wb-error">{error}</span> : null}
      </div>

      <MaxiBindModal open={bindOpen} onClose={() => setBindOpen(false)} onDone={() => void onBound()} />
    </>
  )
}
