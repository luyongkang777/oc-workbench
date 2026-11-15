// 顶栏 DeepSeek 余额胶囊的文案回归。
// node --experimental-strip-types --test scripts/balanceFormat.test.mjs
//
// 三类错最容易出：
//   1. 币种符号写死 ¥，账号换成美元区就显示错；
//   2. 账号不可用 / 余额为负这种状态还显示成绿色，看不出要充值；
//   3. 没配密钥的提示写成像「服务挂了」，用户不知道该配什么。
import assert from 'node:assert/strict'
import test from 'node:test'

import { canForceRefresh, FORCE_REFRESH_GAP_MS } from '../src/api/balance.ts'
import { ageText, currencySymbol, formatBalance, LOW_BALANCE } from '../src/components/balanceFormat.ts'

const NOW = 1794770000 * 1000

test('人民币用 ¥、美元用 $、未知币种把代码写在前面', () => {
  assert.equal(currencySymbol('CNY'), '¥')
  assert.equal(currencySymbol('USD'), '$')
  assert.equal(currencySymbol('EUR'), 'EUR ')
  // 后端没给币种时按人民币兜底（本机默认就是官方 CNY 账号）
  assert.equal(currencySymbol(undefined), '¥')
})

test('正常余额：只显示金额，明细在 title 里', () => {
  const view = formatBalance(
    {
      ok: true,
      source: 'magpie',
      currency: 'CNY',
      total: '12.24',
      granted: '0.00',
      toppedUp: '12.24',
      available: true,
      fetchedAt: 1794769880,
    },
    NOW,
  )
  assert.equal(view.text, '¥12.24')
  assert.equal(view.tone, 'ok')
  assert.ok(view.title.includes('充值 ¥12.24'), view.title)
  assert.ok(view.title.includes('密钥来源：magpie'), view.title)
  assert.ok(view.title.includes('更新于'), view.title)
  // 赠送为 0 时不占标题位置
  assert.ok(!view.title.includes('赠送'), view.title)
})

test('余额低于阈值变黄，够用就是绿色', () => {
  const low = formatBalance(
    { ok: true, currency: 'CNY', total: String(LOW_BALANCE - 0.01), available: true },
    NOW,
  )
  assert.equal(low.tone, 'warn')
  const enough = formatBalance(
    { ok: true, currency: 'CNY', total: String(LOW_BALANCE), available: true },
    NOW,
  )
  assert.equal(enough.tone, 'ok')
})

test('账号不可用时即使有余额也要提示', () => {
  const view = formatBalance(
    { ok: true, currency: 'CNY', total: '0.00', available: false, granted: '0.00' },
    NOW,
  )
  assert.equal(view.tone, 'bad')
  assert.ok(view.title.includes('账号当前不可用'), view.title)
})

test('没配密钥和查询失败要分开说', () => {
  const missing = formatBalance({ ok: false, error: '没有找到 DeepSeek 官方密钥：可以在 settings.json 填 deepseekApiKey' })
  assert.equal(missing.text, '余额未配置')
  assert.ok(missing.title.includes('deepseekApiKey'), missing.title)

  const broken = formatBalance({ ok: false, error: '访问 DeepSeek 余额接口失败：超时' })
  assert.equal(broken.text, '余额 —')
  assert.equal(broken.tone, 'bad')
})

test('首次加载（还没有结果）显示占位', () => {
  const view = formatBalance(null)
  assert.equal(view.text, '余额 …')
  assert.equal(view.tone, 'pending')
})

test('时间描述按跨度退化', () => {
  assert.equal(ageText(undefined), '未知时间')
  assert.equal(ageText(Math.floor(NOW / 1000), NOW), '刚刚')
  assert.equal(ageText(Math.floor(NOW / 1000) - 180, NOW), '3 分钟前')
  assert.equal(ageText(Math.floor(NOW / 1000) - 7200, NOW), '2 小时前')
})

// ---------- 实时刷新的节流 ----------
//
// 一次对话里 step.ended 会连着来几条，每条都打官方接口既没必要也容易限频。
// 这里锁住「2.5 秒内只强制刷一次」，同时保证首次（lastAt=0）一定放行。

test('强制刷新首次放行、间隔内忽略、超过间隔再放行', () => {
  const now = 1_000_000
  assert.equal(canForceRefresh(0, now), true)
  assert.equal(canForceRefresh(now - FORCE_REFRESH_GAP_MS + 1, now), false)
  assert.equal(canForceRefresh(now - FORCE_REFRESH_GAP_MS, now), true)
  assert.equal(canForceRefresh(now, now), false)
})

test('节流窗口可注入，便于按场景调整', () => {
  const now = 500_000
  assert.equal(canForceRefresh(now - 800, now, 500), true)
  assert.equal(canForceRefresh(now - 100, now, 500), false)
})
