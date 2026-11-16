// dev 的额度查询（对齐 shell/src/provider_quota.rs + provider_quota_fetch.rs）。

import { httpError } from './dev-local-provider-util.mjs'
import { readConfig } from './dev-local-provider-store.mjs'

/**
 * 额度查询（与 shell/src/provider_quota.rs 同口径）。
 *
 * 只有 DeepSeek 有公开余额接口；OpenCode Go / Command Code 没有（实测一堆 404），
 * 如实返回控制台地址，不编造剩余额度。
 */
function consoleUrlFor(baseURL) {
  const lower = String(baseURL || '').toLowerCase()
  if (lower.includes('opencode.ai')) return 'https://opencode.ai/console'
  if (lower.includes('commandcode.ai')) return 'https://commandcode.ai/studio'
  if (lower.includes('deepseek.com')) return 'https://platform.deepseek.com/top_up'
  return ''
}

/** microCents → 美元（1 美元 = 1e8 microCents）。 */
function microCentsToUsd(raw) {
  const value = Number(raw ?? 0)
  if (!Number.isFinite(value)) return 0
  return Math.round((value / 100000000) * 100) / 100
}

/** OpenCode GO 套餐的三个计量窗口（Bearer 就能读，不需要登录 cookie）。 */
async function opencodeMeters(apiKey) {
  const res = await fetch('https://opencode.ai/console/api/go/status', {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  const meters = json?.access?.meters
  if (!meters) throw new Error('响应里没有 access.meters')
  const out = {}
  for (const key of ['fiveHour', 'week', 'month']) {
    const meter = meters[key]
    if (!meter) continue
    out[key] = {
      used: microCentsToUsd(meter.usedMicroCents),
      limit: microCentsToUsd(meter.limitMicroCents),
      resetsAt: meter.resetsAt || '',
    }
  }
  if (Object.keys(out).length === 0) throw new Error('没有可用的计量窗口')
  return out
}

/** Command Code 的用量接口根（与它 CLI 一致）。 */
const COMMANDCODE_API = 'https://api.commandcode.ai'

async function ccJson(path, apiKey) {
  const res = await fetch(COMMANDCODE_API + path, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function planLabel(planId) {
  const tail = String(planId || '').toLowerCase().split('-').pop()
  const map = { go: 'Go', goat: 'GOAT', pro: 'Pro', max: 'Max', ultra: 'Ultra', provider: 'Provider' }
  return map[tail] || planId || ''
}

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100

/**
 * Command Code 额度（实测个人账号）：
 *   * `/alpha/whoami` 的 `org` 为 null 时**不要传 orgId**（传了 400/403）；
 *   * credits 里的窗口是对象 `windowLimits.{fiveHour,weekly}`，`resetAt` 是毫秒时间戳。
 */
async function commandcodeUsage(apiKey) {
  const whoami = await ccJson('/alpha/whoami?limits=1', apiKey)
  const orgId = whoami?.org?.id || ''
  const suffix = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''

  const credits = await ccJson(`/alpha/billing/credits${suffix}`, apiKey)
  const subscription = await ccJson(`/alpha/billing/subscriptions${suffix}`, apiKey).catch(() => null)
  const summary = await ccJson(`/alpha/usage/summary${suffix}`, apiKey).catch(() => null)

  const monthly = Math.max(0, credits?.credits?.monthlyCredits ?? 0)
  const purchased = Math.max(0, credits?.credits?.purchasedCredits ?? 0)
  const free = Math.max(0, credits?.credits?.freeCredits ?? 0)
  const remaining = monthly + purchased + free

  const windows = []
  const limits = credits?.windowLimits || {}
  for (const [key, label] of [
    ['fiveHour', '5 小时'],
    ['weekly', '本周'],
  ]) {
    const window = limits[key]
    if (!window) continue
    windows.push({
      label,
      used: round2(window.used ?? 0),
      cap: round2(window.cap ?? 0),
      resetAt: window.resetAt ?? null,
    })
  }

  return {
    ok: true,
    kind: 'credits',
    currency: 'USD',
    plan: planLabel(subscription?.data?.planId),
    status: subscription?.data?.status ?? '',
    remaining: round2(remaining),
    spent: round2(summary?.totalCost ?? 0),
    periodStart: subscription?.data?.currentPeriodStart ?? '',
    periodEnd: subscription?.data?.currentPeriodEnd ?? '',
    windows,
    consoleUrl: 'https://commandcode.ai/studio',
  }
}

export async function providerQuota(id) {
  const { value } = readConfig()
  const entry = value?.provider?.[id]
  if (!entry) throw httpError(404, `没有找到 provider ${id}`)
  const baseURL = entry.options?.baseURL || ''
  const apiKey = entry.options?.apiKey || ''
  const lower = String(baseURL).toLowerCase()

  if (lower.includes('opencode.ai') && apiKey) {
    try {
      return {
        ok: true,
        kind: 'meters',
        currency: 'USD',
        meters: await opencodeMeters(apiKey),
        consoleUrl: 'https://opencode.ai/console',
      }
    } catch (err) {
      return {
        ok: true,
        kind: 'console',
        consoleUrl: 'https://opencode.ai/console',
        note: `没读到套餐额度（${err.message}），请到控制台查看`,
      }
    }
  }

  if (lower.includes('commandcode.ai') && apiKey) {
    try {
      return await commandcodeUsage(apiKey)
    } catch (err) {
      return {
        ok: true,
        kind: 'console',
        consoleUrl: 'https://commandcode.ai/studio',
        note: `没读到套餐额度（${err.message}），请到控制台查看`,
      }
    }
  }

  if (!lower.includes('api.deepseek.com') || !apiKey) {
    return {
      ok: true,
      kind: 'console',
      consoleUrl: consoleUrlFor(baseURL),
      note: '该服务商没有公开的额度接口，请到控制台查看',
    }
  }
  let res
  try {
    res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    return { ok: false, kind: 'balance', error: `连不上余额接口：${err.message}` }
  }
  if (!res.ok) return { ok: false, kind: 'balance', error: `余额接口返回 HTTP ${res.status}` }
  const json = await res.json().catch(() => null)
  const info = json?.balance_infos?.[0]
  if (!info) return { ok: false, kind: 'balance', error: '余额响应里没有 balance_infos' }
  return {
    ok: true,
    kind: 'balance',
    currency: info.currency || 'CNY',
    total: info.total_balance ?? '0.00',
    available: json.is_available !== false,
    consoleUrl: 'https://platform.deepseek.com/top_up',
  }
}
