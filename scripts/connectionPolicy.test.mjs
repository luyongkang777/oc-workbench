// 断开态自动重连节奏的回归：node --experimental-strip-types --test scripts/connectionPolicy.test.mjs
//
// 这段节奏坏了只有两种表现，都很难在界面上看出来：
//   1. 退避没生效（每秒跑一次 pair）→ opencode 那边被一次性链接刷爆；
//   2. 退避太慢（第一次就等 15 秒）→ 用户看到的还是「未连接」很久。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FIRST_RECONNECT_DELAY_MS,
  HIDDEN_RECHECK_MS,
  hiddenRecheckDelay,
  nextReconnectDelay,
  shouldReconnectNow,
} from '../src/components/connectionPolicy.ts'

test('第一次重连要快：1 秒级，不是退避上限', () => {
  assert.equal(nextReconnectDelay(0), FIRST_RECONNECT_DELAY_MS)
  assert.ok(FIRST_RECONNECT_DELAY_MS <= 2_000)
})

test('退避递增，且封顶在 15 秒', () => {
  const delays = [1, 2, 3, 4, 5, 20].map((attempt) => nextReconnectDelay(attempt))
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(delays[i] >= delays[i - 1], `第 ${i} 次不应比上一次更短：${delays}`)
  }
  assert.equal(delays.at(-1), 15_000)
})

test('非法 attempt 退回第一次的等待，不会算出 0 或 NaN', () => {
  for (const bad of [-3, Number.NaN, Number.POSITIVE_INFINITY]) {
    const delay = nextReconnectDelay(bad)
    assert.ok(Number.isFinite(delay) && delay > 0, `${bad} 算出了 ${delay}`)
  }
  // 负数和 NaN 都按「还没试过」处理
  assert.equal(nextReconnectDelay(-3), FIRST_RECONNECT_DELAY_MS)
  assert.equal(nextReconnectDelay(Number.NaN), FIRST_RECONNECT_DELAY_MS)
})

test('隐藏标签页不重连，可见才重连', () => {
  assert.equal(shouldReconnectNow(true), false)
  assert.equal(shouldReconnectNow(false), true)
})

test('隐藏态复查间隔是有限的正数（不能被当成 0 卡成死循环）', () => {
  assert.equal(hiddenRecheckDelay(), HIDDEN_RECHECK_MS)
  assert.ok(HIDDEN_RECHECK_MS >= 1_000)
})
