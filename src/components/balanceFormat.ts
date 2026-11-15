/**
 * 余额胶囊的文案与配色（纯函数，方便单测）。
 *
 * 界面只放「¥12.24」这么点字，明细全塞进 title：赠送/充值/更新时间/密钥来源。
 * 余额低、账号不可用、没配密钥这几种情况要能一眼区分，所以颜色分四档。
 */

import type { DeepSeekBalance } from '../api/balance'

export type BalanceTone = 'ok' | 'warn' | 'bad' | 'pending'

export type BalanceView = {
  /** 胶囊里的短文字。 */
  text: string
  /** 悬停提示：明细 + 操作提示。 */
  title: string
  tone: BalanceTone
}

/** 低于这个金额变黄，提醒该充值了。 */
export const LOW_BALANCE = 5

const SYMBOLS: Record<string, string> = { CNY: '¥', USD: '$' }

export function currencySymbol(currency: string | undefined): string {
  if (!currency) return '¥'
  return SYMBOLS[currency] ?? `${currency} `
}

/** 「刚刚 / 3 分钟前 / 2 小时前」。 */
export function ageText(fetchedAt: number | undefined, now = Date.now()): string {
  if (!fetchedAt) return '未知时间'
  const seconds = Math.max(0, Math.round((now - fetchedAt * 1000) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  return `${Math.round(minutes / 60)} 小时前`
}

function sourceText(source: string): string {
  if (source === 'settings') return '设置文件'
  if (source === 'magpie') return 'magpie'
  if (source === 'env') return '环境变量'
  return source
}

export function formatBalance(b: DeepSeekBalance | null, now = Date.now()): BalanceView {
  if (!b) {
    return { text: '余额 …', title: '正在查询 DeepSeek 余额', tone: 'pending' }
  }
  if (b.ok !== true) {
    const error = b.error || '余额未知'
    // 「没找到密钥」和「密钥无效（401）」是两件事：前者要教用户去配，
    // 后者要提示他换一个。别把 401 也显示成「余额未配置」。
    const missing = error.includes('没有找到') || error.includes('未配置')
    return {
      text: missing ? '余额未配置' : '余额 —',
      title: `${error}（点一下可重试）`,
      tone: 'bad',
    }
  }

  const symbol = currencySymbol(b.currency)
  const total = b.total ?? '0.00'
  const numeric = Number(total)
  const low = Number.isFinite(numeric) && numeric < LOW_BALANCE
  const parts = [`DeepSeek 余额 ${symbol}${total}`]
  if (b.granted && b.granted !== '0.00') parts.push(`赠送 ${symbol}${b.granted}`)
  if (b.toppedUp && b.toppedUp !== '0.00') parts.push(`充值 ${symbol}${b.toppedUp}`)
  parts.push(`更新于${ageText(b.fetchedAt, now)}`)
  if (b.source) parts.push(`密钥来源：${sourceText(b.source)}`)
  if (b.available === false) parts.push('账号当前不可用（余额耗尽或未开通）')

  return {
    text: `${symbol}${total}`,
    title: `${parts.join(' · ')}（点击刷新）`,
    tone: b.available === false ? 'bad' : low ? 'warn' : 'ok',
  }
}
