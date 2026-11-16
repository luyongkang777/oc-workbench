// 额度 / 用量文案回归。
// node --experimental-strip-types --test scripts/providerQuota.test.mjs
//
// 这类文案最容易出的错：把「查不到额度」写成 0、把美元符号写错、
// 或者把本机累计消耗说成「剩余额度」（用户会以为余额还有那么多）。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  creditsText,
  formatTokens,
  metersText,
  nextResetText,
  percentLeft,
  quotaDetailText,
  quotaText,
  usageText,
} from '../src/components/providerQuotaFormat.ts'

test('DeepSeek 余额按币种给符号', () => {
  const quota = {
    ok: true,
    kind: 'balance',
    currency: 'CNY',
    total: '17.06',
    available: true,
    consoleUrl: '',
  }
  assert.equal(quotaText(quota, undefined), '余额 ¥17.06')
  assert.equal(quotaText({ ...quota, currency: 'USD', total: '3.20' }, undefined), '余额 $3.20')
  assert.equal(quotaText({ ...quota, currency: 'EUR' }, undefined), '余额 EUR 17.06')
  assert.equal(quotaText({ ...quota, available: false }, undefined), '余额 ¥17.06（账号不可用）')
})

test('没有公开额度接口时不编造数字', () => {
  const consoleOnly = { ok: true, kind: 'console', consoleUrl: 'https://x', note: '去控制台看' }
  assert.equal(quotaText(consoleOnly, undefined), '')
  assert.equal(quotaText({ ok: false, error: '401' }, undefined), '额度查询失败')
  assert.equal(quotaText(null, undefined), '')
})

test('本机用量文案：tokens 缩写 + 有花费才显示金额', () => {
  assert.equal(usageText({ tokens: 1_234_567, cost: 0, steps: 3 }), '本机已用 1.2M tokens')
  assert.equal(usageText({ tokens: 1234, cost: 0.5, steps: 2 }), '本机已用 1k tokens · $0.50')
  assert.equal(usageText({ tokens: 0, cost: 0, steps: 0 }), '')
  assert.equal(usageText(undefined), '')
})

test('formatTokens 边界', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(-5), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1500), '2k')
  assert.equal(formatTokens(1_000_000), '1.0M')
})

test('剩余百分比：四舍五入、越界夹紧、上限无效时不给数字', () => {
  assert.equal(percentLeft(0, 12), 100)
  assert.equal(percentLeft(10.63, 60), 82)
  // 差一点点就满额：显示 99%，不能四舍五入成 100%（否则「用过一点」和「没用过」一样）
  assert.equal(percentLeft(0.01, 30), 99)
  assert.equal(percentLeft(19.35, 35), 44)
  // 用超了不能显示负剩余
  assert.equal(percentLeft(15, 12), 0)
  // used 为负（脏数据）也不能超过 100%
  assert.equal(percentLeft(-1, 12), 100)
  // 上限 0 / 负数 / NaN：不给数字，避免显示成「剩 0%」误导成额度耗尽
  assert.equal(percentLeft(0, 0), null)
  assert.equal(percentLeft(1, -5), null)
  assert.equal(percentLeft(1, Number.NaN), null)
})

test('OpenCode 套餐额度按「剩余百分比」显示三个窗口', () => {
  const quota = {
    ok: true,
    kind: 'meters',
    currency: 'USD',
    consoleUrl: '',
    meters: {
      fiveHour: { used: 0, limit: 12, resetsAt: '2026-11-16T17:07:49.000Z' },
      week: { used: 0.01, limit: 30, resetsAt: '2026-11-23T00:00:00.000Z' },
      month: { used: 10.63, limit: 60, resetsAt: '2026-12-02T12:34:29.000Z' },
    },
  }
  assert.equal(metersText(quota), '5 小时 剩 100% · 本周 剩 99% · 本月 剩 82%')
  // 金额明细放 title
  assert.equal(
    quotaDetailText(quota),
    '5 小时 $0/12 · 本周 $0.01/30 · 本月 $10.63/60',
  )
  // 没有公开额度的类型不产生文案
  assert.equal(metersText({ ok: true, kind: 'console', consoleUrl: 'x', note: 'y' }), '')
  assert.equal(metersText(null), '')
  // 缺窗口时只显示有的
  assert.equal(
    metersText({ ...quota, meters: { month: quota.meters.month } }),
    '本月 剩 82%',
  )
  // 上限是 0 的坏数据：整段跳过，不写「剩 0%」
  assert.equal(metersText({ ...quota, meters: { month: { used: 1, limit: 0, resetsAt: '' } } }), '')
})

test('最近重置时间取三个窗口里最早的那个', () => {
  const quota = {
    ok: true,
    kind: 'meters',
    currency: 'USD',
    consoleUrl: '',
    meters: {
      fiveHour: { used: 0, limit: 12, resetsAt: '2026-11-16T17:07:49.000Z' },
      week: { used: 0, limit: 30, resetsAt: '2026-11-23T00:00:00.000Z' },
      month: { used: 0, limit: 60, resetsAt: '2026-12-02T12:34:29.000Z' },
    },
  }
  const text = nextResetText(quota)
  assert.ok(text.startsWith('最近重置：'))
  assert.ok(!Number.isNaN(Date.parse('2026-11-16T17:07:49.000Z')))
})

test('Command Code 额度：总剩余百分比 + 滚动窗口', () => {
  const quota = {
    ok: true,
    kind: 'credits',
    currency: 'USD',
    plan: 'goat',
    status: 'active',
    remaining: 8.5,
    spent: 1.5,
    periodEnd: '2026-12-01T00:00:00.000Z',
    windows: [
      { label: '5 小时', used: 0.1, cap: 1, resetAt: '' },
      { label: '周', used: 0.5, cap: 3, resetAt: '' },
    ],
    consoleUrl: 'https://commandcode.ai/studio',
  }
  // 总剩余 = remaining / (remaining + spent) = 8.5 / 10 = 85%
  assert.equal(creditsText(quota), '剩余 85% · 5 小时 剩 90% · 周 剩 83%')
  // 金额明细放 title
  assert.equal(
    quotaDetailText(quota),
    '剩余 $8.50 · 已用 $1.50 · 5 小时 $0.10/1 · 周 $0.50/3',
  )
  // 没花钱：总量只剩 remaining，剩 100%，也不显示「已用 0」
  assert.equal(creditsText({ ...quota, spent: 0, windows: [] }), '剩余 100%')
  assert.equal(quotaDetailText({ ...quota, spent: 0, windows: [] }), '剩余 $8.50')
  // 额度和花费都是 0（新账号）：算不出百分比，写「剩余 —」而不是空串，
  // 否则列表上整行额度会消失，看起来像这家没有额度
  assert.equal(
    creditsText({ ...quota, remaining: 0, spent: 0, windows: [] }),
    '剩余 —',
  )
  // 花光了显示 0%（有信息量，不能省略）
  assert.equal(creditsText({ ...quota, remaining: 0, spent: 5, windows: [] }), '剩余 0%')
  // 其它类型不产生文案
  assert.equal(creditsText({ ok: true, kind: 'console', consoleUrl: 'x', note: 'y' }), '')
  assert.equal(creditsText(null), '')
})
