import {
  creditsText,
  metersText,
  nextResetText,
  quotaDetailText,
  quotaText,
  usageText,
  type ProviderQuota,
  type ProviderUsage,
} from './providerQuotaFormat'

type Props = {
  quota: ProviderQuota | undefined
  usage: ProviderUsage | undefined
  /** 打开服务商控制台（走外壳的 open-url，WebView2 里 window.open 会被拦） */
  onOpenConsole: (url: string) => void
}

/**
 * 把金额明细与重置时间拼成 title：主行只显示百分比，细节靠悬停。
 *
 * 两段都为空时返回 undefined（不是 `''`）—— 否则 DOM 上会多一个空的
 * `title=""` 属性，读屏软件会念一个空提示。
 */
function titleFor(quota: ProviderQuota | undefined, reset: string): string | undefined {
  return [quotaDetailText(quota), reset].filter(Boolean).join(' · ') || undefined
}

/**
 * 编辑区里的额度框：余额 / 套餐百分比 / 只有控制台地址 / 查询失败。
 *
 * 从 ProviderPanel 拆出来（面板主体保持在 300 行内）；五种分支都在这里，
 * 主面板只负责传 quota 与用量。
 */
export default function ProviderQuotaBox({ quota, usage, onOpenConsole }: Props) {
  if (!quota) return null
  const usageLine = usageText(usage)
  const reset = nextResetText(quota)
  // 主行文案（百分比）可能为空（窗口上限全是 0）；为空时别拼「 · 本机已用 …」，
  // 否则行首会多出一个孤零零的分隔符。
  const meters = quota.ok && quota.kind === 'meters' ? metersText(quota) : ''
  const credits = quota.ok && quota.kind === 'credits' ? creditsText(quota) : ''
  const metersUsage = meters && usageLine ? ` · ${usageLine}` : ''
  const creditsUsage = credits && usageLine ? ` · ${usageLine}` : ''

  return (
    <div className="provider-quota-box">
      {quota.ok && quota.kind === 'balance' ? (
        <span className="provider-quota-line">
          {quotaText(quota, usage)}
          {usageLine ? ` · ${usageLine}` : ''}
        </span>
      ) : null}

      {quota.ok && quota.kind === 'meters' ? (
        <>
          <span className="provider-quota-line" title={titleFor(quota, reset)}>
            {meters}
            {metersUsage}
          </span>
          {quota.consoleUrl ? (
            <button type="button" className="provider-btn" onClick={() => onOpenConsole(quota.consoleUrl)}>
              打开控制台
            </button>
          ) : null}
        </>
      ) : null}

      {quota.ok && quota.kind === 'credits' ? (
        <>
          <span className="provider-quota-line" title={titleFor(quota, reset)}>
            {credits}
            {creditsUsage}
          </span>
          {quota.consoleUrl ? (
            <button type="button" className="provider-btn" onClick={() => onOpenConsole(quota.consoleUrl)}>
              打开控制台
            </button>
          ) : null}
        </>
      ) : null}

      {quota.ok && quota.kind === 'console' ? (
        <>
          <span className="provider-quota-line">
            {quota.note}
            {usageLine ? `；${usageLine}` : ''}
          </span>
          {quota.consoleUrl ? (
            <button type="button" className="provider-btn" onClick={() => onOpenConsole(quota.consoleUrl)}>
              打开控制台看额度
            </button>
          ) : null}
        </>
      ) : null}

      {quota.ok === false ? (
        <span className="provider-quota-line provider-quota-bad">
          额度查询失败：{quota.error}
        </span>
      ) : null}
    </div>
  )
}
