import { creditsText, metersText, nextResetText, quotaText, usageText } from './providerQuotaFormat'
import { PRESET_ICONS } from './providerPresets'
import { presetForBaseURL } from './providerForm'
import type { ProviderController } from '../hooks/useProviderPanel'

type Props = {
  controller: ProviderController
  /** 正在等待二次确认删除的 provider id */
  pendingDelete: string | null
  onPendingDelete: (id: string | null) => void
}

/**
 * 已配置的 provider 列表：图标 + 名称 + 额度/用量 + 两步删除。
 *
 * 从 ProviderPanel 拆出来（面板主体保持在 300 行内）；数据全来自 controller。
 */
export default function ProviderList({ controller, pendingDelete, onPendingDelete }: Props) {
  const { status, quota, usage, form, busy, edit, remove } = controller
  const providers = status?.providers ?? []

  return (
                <ul className="provider-list">
                  {providers.map((info) => {
                    // 先取一次再判 kind：联合类型在重复 index access 下收窄不了
                    const itemQuota = quota[info.id]
                    const balanceLine = quotaText(itemQuota, usage[info.id])
                    const metersLine = metersText(itemQuota) || creditsText(itemQuota)
                    const resetLine = nextResetText(itemQuota)
                    const usageLine = usageText(usage[info.id])
                    const consoleUrl =
                      itemQuota && itemQuota.ok && itemQuota.kind === 'console' ? itemQuota.consoleUrl : ''
                    return (
                    <li key={info.id} className={`provider-item${form.id === info.id ? ' active' : ''}`}>
                      <button
                        type="button"
                        className="provider-item-main"
                        onClick={() => edit(info)}
                        disabled={busy}
                      >
                        {(() => {
                          const known = presetForBaseURL(info.baseURL)
                          return known ? (
                            <img className="provider-icon" src={PRESET_ICONS[known.icon]} alt="" />
                          ) : (
                            <span className="provider-icon provider-icon-fallback" aria-hidden="true">
                              {info.name.slice(0, 1).toUpperCase()}
                            </span>
                          )
                        })()}
                        <span className="provider-item-text">
                          <span className="provider-item-name">{info.name}</span>
                          <span className="provider-item-id">{info.id}</span>
                          <span className="provider-item-meta">
                            {info.modelCount} 个模型 · {info.keyMasked || '未填密钥'}
                          </span>
                          <span className="provider-item-url">{info.baseURL}</span>
                          {usageLine ? <span className="provider-item-usage">{usageLine}</span> : null}
                          {balanceLine ? (
                            <span className="provider-item-quota">{balanceLine}</span>
                          ) : metersLine ? (
                            <span className="provider-item-quota" title={resetLine}>
                              {metersLine}
                            </span>
                          ) : consoleUrl ? (
                            <span className="provider-item-quota">额度：到控制台查看</span>
                          ) : null}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`provider-item-del${pendingDelete === info.id ? ' confirm' : ''}`}
                        onClick={() => {
                          if (pendingDelete === info.id) {
                            onPendingDelete(null)
                            void remove(info.id)
                          } else {
                            onPendingDelete(info.id)
                          }
                        }}
                        disabled={busy}
                        title={`删除 ${info.id}（会先备份配置）`}
                      >
                        {pendingDelete === info.id ? '确认删除' : '删除'}
                      </button>
                    </li>
                    )
                  })}
                </ul>
  )
}
