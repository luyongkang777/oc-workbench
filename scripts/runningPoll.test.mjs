// 「会话在不在生成」轮询的判定回归：
//   node --experimental-strip-types --test scripts/runningPoll.test.mjs
//
// 挡的是用户报过的那个 bug：对话明明在跑，界面却一直显示没在跑，
// 只有切到别的会话再切回来才恢复。根因是轮询「自认为空闲就彻底停手」，
// 任何一次误判都永久停在那里。这里把判定拆成纯函数，逐条钉住。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOCAL_INTERVALS,
  NO_STOP_GUARD,
  REMOTE_INTERVALS,
  STOP_GRACE_MS,
  looksBusy,
  nextRunningID,
  pollDelay,
  respectStopGrace,
} from '../src/components/runningPoll.ts'

test('busy 比 idle 新 = 正在生成', () => {
  assert.equal(looksBusy({ time: { busy: 200, idle: 100 } }), true)
})

test('idle 比 busy 新 = 空闲', () => {
  assert.equal(looksBusy({ time: { busy: 100, idle: 200 } }), false)
})

test('时间字段缺失时判空闲（坏数据不该把按钮锁成停止）', () => {
  assert.equal(looksBusy(null), false)
  assert.equal(looksBusy({}), false)
  assert.equal(looksBusy({ time: {} }), false)
})

test('查到在跑 → runningID 是这条会话自己的 id', () => {
  assert.equal(nextRunningID('ses_a', { time: { busy: 2, idle: 1 } }), 'ses_a')
})

test('查到空闲 → runningID 归 null', () => {
  assert.equal(nextRunningID('ses_a', { time: { busy: 1, idle: 2 } }), null)
})

test('切会话时结论只写回被查询的那条（不能把 A 的结论写到 B 上）', () => {
  const busy = { time: { busy: 2, idle: 1 } }
  assert.equal(nextRunningID('ses_b', busy), 'ses_b')
  assert.notEqual(nextRunningID('ses_b', busy), 'ses_a')
})

test('空闲也必须继续轮询：间隔存在且比生成中慢，不是「停掉」', () => {
  for (const intervals of [LOCAL_INTERVALS, REMOTE_INTERVALS]) {
    assert.ok(intervals.idle > 0, '空闲间隔不能是 0（0 等于不再查）')
    assert.ok(intervals.idle > intervals.busy, '空闲必须比生成中慢，否则白占请求线程')
    // 兜底周期的上限：超过 10 秒用户已经能明显感到「卡住」
    assert.ok(intervals.idle <= 10_000, `空闲间隔 ${intervals.idle}ms 太长，自愈会慢到像卡死`)
  }
})

test('pollDelay 按状态取对应档位', () => {
  assert.equal(pollDelay(LOCAL_INTERVALS, true), LOCAL_INTERVALS.busy)
  assert.equal(pollDelay(LOCAL_INTERVALS, false), LOCAL_INTERVALS.idle)
  assert.equal(pollDelay(REMOTE_INTERVALS, true), REMOTE_INTERVALS.busy)
  assert.equal(pollDelay(REMOTE_INTERVALS, false), REMOTE_INTERVALS.idle)
})

test('远程整体比本地慢：公网往返不能当本地心跳打', () => {
  assert.ok(REMOTE_INTERVALS.busy >= LOCAL_INTERVALS.busy)
  assert.ok(REMOTE_INTERVALS.idle >= LOCAL_INTERVALS.idle)
})

test('手动停止后的抑制窗口内：服务端还没翻 idle 也不闪回「在跑」', () => {
  const now = Date.now()
  const guard = { until: now + STOP_GRACE_MS, busyAt: now - 5000, sessionID: 'ses_a' }
  // 服务端仍说在跑，但用户在窗口内点过停止 → 按已停处理
  assert.equal(respectStopGrace(true, now, guard, 'ses_a', now - 5000), false)
  assert.equal(respectStopGrace(true, guard.until - 1, guard, 'ses_a', now - 5000), false)
  // 窗口结束后照实读
  assert.equal(respectStopGrace(true, guard.until, guard, 'ses_a', now - 5000), true)
  assert.equal(respectStopGrace(true, guard.until + 1000, guard, 'ses_a', now - 5000), true)
})

test('没有抑制（until=0）时照实读', () => {
  const now = Date.now()
  assert.equal(respectStopGrace(true, now, NO_STOP_GUARD, 'ses_a'), true)
  assert.equal(respectStopGrace(false, now, NO_STOP_GUARD, 'ses_a'), false)
})

test('服务端已经说空闲时，抑制窗口不改变结论', () => {
  const now = Date.now()
  const guard = { until: now + STOP_GRACE_MS, busyAt: 0, sessionID: 'ses_a' }
  assert.equal(respectStopGrace(false, now, guard, 'ses_a', now), false)
})

test('抑制窗口要盖住远程最慢轮询，否则远程看不到抑制', () => {
  assert.ok(STOP_GRACE_MS > 0 && STOP_GRACE_MS <= 5000, `STOP_GRACE_MS=${STOP_GRACE_MS}`)
  assert.ok(STOP_GRACE_MS > REMOTE_INTERVALS.busy, '窗口比远程轮询短时，那一拍已经过期')
})

test('换了会话：窗口只压停止那条，不能把 B 的生成判成空闲', () => {
  const now = Date.now()
  const guard = { until: now + STOP_GRACE_MS, busyAt: 0, sessionID: 'ses_a' }
  assert.equal(respectStopGrace(true, now, guard, 'ses_b'), true)
})

test('抑制窗口内也要放行「停止后新起的一轮」，但同域比较', () => {
  const now = Date.now()
  const guard = { until: now + STOP_GRACE_MS, busyAt: 1000, sessionID: 'ses_a' }
  // 停止后又发了一条：服务端 busy 比停止时看到的更新
  assert.equal(respectStopGrace(true, now, guard, 'ses_a', 2000), true)
  // 还是停止前那一轮：busy 没变，必须压住
  assert.equal(respectStopGrace(true, now, guard, 'ses_a', 1000), false)
  // 停止时还没读到过 busy：保守压住，宁可闪一下也不误放行
  assert.equal(respectStopGrace(true, now, { ...guard, busyAt: 0 }, 'ses_a', 2000), false)
})

test('stop 之后 start 新一轮：抑制窗口必须放行，不能把刚起来的生成压成空闲', () => {
  // 挡的是审查抓到的真问题：窗口若不绑会话/不认新一轮，
  // 「停止后 1.5 秒内再发一条」会被压掉一次，按钮闪回「发送」。
  const now = Date.now()
  const guard = { until: now + STOP_GRACE_MS, busyAt: 1000, sessionID: 'ses_a' }
  // 同一会话、服务端 busy 比停止时更新 = 新的一轮 → 放行
  assert.equal(respectStopGrace(true, now + 50, guard, 'ses_a', 2000), true)
  // 换了会话 → 放行（窗口不能压别的会话）
  assert.equal(respectStopGrace(true, now + 50, guard, 'ses_b', 1000), true)
  // 同一会话同一轮、仍在窗口内 → 压制
  assert.equal(respectStopGrace(true, now + 50, guard, 'ses_a', 1000), false)
  // 窗口过期 → 放行
  assert.equal(respectStopGrace(true, now + STOP_GRACE_MS, guard, 'ses_a', 1000), true)
})

test('NO_STOP_GUARD 等于「不抑制」', () => {
  assert.equal(respectStopGrace(true, Date.now(), NO_STOP_GUARD, 'ses_a', 1000), true)
})

