// 历史会话列表的过滤与分组回归：
//   node --experimental-strip-types --test scripts/sessionList.test.mjs
//
// 两类错最容易出：
//   1. 分组按「多少小时前」而不是自然日 —— 昨晚 23:40 和今天 00:10 差半小时却要分两组
//   2. 没有时间戳的会话被直接丢掉 —— 历史里那些脏数据会凭空消失
import assert from 'node:assert/strict'
import test from 'node:test'

import { filterSessions, groupSessions, listSessionAt, mergeSessionList } from '../src/components/sessionList.ts'

/** 造一条会话：默认只有标题。 */
const at = (id, title, updated) => ({
  id,
  title,
  time: updated === undefined ? {} : { updated },
})

test('最后一次对话时间优先取 updated，退到 created', () => {
  assert.equal(listSessionAt({ id: 'a', time: { updated: 500, created: 100 } }), 500)
  assert.equal(listSessionAt({ id: 'a', time: { created: 100 } }), 100)
  assert.equal(listSessionAt({ id: 'a', time: {} }), undefined)
  // 0 是坏数据，不能当成「1970 年那条会话」
  assert.equal(listSessionAt({ id: 'a', time: { updated: 0 } }), undefined)
})

test('关键字过滤只认标题，空关键字原样返回', () => {
  const list = [at('1', '修复登录', 1), at('2', 'git push 卡住', 2), at('3', undefined, 3)]
  assert.deepEqual(
    filterSessions(list, '').map((item) => item.id),
    ['1', '2', '3'],
  )
  assert.deepEqual(
    filterSessions(list, '   ').map((item) => item.id),
    ['1', '2', '3'],
  )
  assert.deepEqual(
    filterSessions(list, '登录').map((item) => item.id),
    ['1'],
  )
  // 英文不区分大小写
  assert.deepEqual(
    filterSessions(list, 'GIT').map((item) => item.id),
    ['2'],
  )
})

test('按自然日分组：今天 / 昨天 / 近 7 天 / 更早', () => {
  const now = new Date(2026, 10, 18, 12, 0, 0).getTime()
  const day = 86_400_000
  const list = [
    at('today', '今天的', now - 3_600_000),
    // 昨天 23:40：只比现在早十几个小时，但仍然是「昨天」
    at('yesterday', '昨晚的', new Date(2026, 10, 17, 23, 40).getTime()),
    at('week', '前几天的', now - 3 * day),
    at('older', '上个月的', now - 40 * day),
  ]
  const groups = groupSessions(list, now)
  assert.deepEqual(
    groups.map((group) => [group.key, group.items.map((item) => item.id)]),
    [
      ['today', ['today']],
      ['yesterday', ['yesterday']],
      ['week', ['week']],
      ['older', ['older']],
    ],
  )
})

test('空分组不出现：历史少的时候不该出现四行小标题', () => {
  const now = Date.now()
  const groups = groupSessions([at('a', '只有今天', now)], now)
  assert.deepEqual(
    groups.map((group) => group.key),
    ['today'],
  )
})

test('没有时间戳的会话归到「更早」，不能丢', () => {
  const groups = groupSessions([at('x', '脏数据', undefined)], Date.now())
  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, 'older')
  assert.deepEqual(
    groups[0].items.map((item) => item.id),
    ['x'],
  )
})

test('过滤 + 分组串起来用：过滤后只剩命中项，分组跟着缩', () => {
  const now = Date.now()
  const list = [at('1', '登录问题', now), at('2', '别的话题', now), at('3', '登录超时', now - 40 * 86_400_000)]
  const groups = groupSessions(filterSessions(list, '登录'), now)
  const ids = groups.flatMap((group) => group.items.map((item) => item.id))
  assert.deepEqual(ids, ['1', '3'])
})

test('轮询只取一页时，合并不能把已展开的历史缩水', () => {
  const previous = [at('a', '新', 9), at('b', '旧', 8), at('c', '更旧', 7)]
  // 轮询只返回了最新一条
  const fresh = [at('a', '新', 9)]
  const merged = mergeSessionList(fresh, previous, 120)
  assert.deepEqual(merged.map((item) => item.id), ['a', 'b', 'c'])
})

test('合并时服务端顺序和字段优先，不拿旧数据盖新数据', () => {
  const previous = [at('a', '旧标题', 1), at('b', 'B', 2)]
  const fresh = [at('a', '改过的标题', 5)]
  const merged = mergeSessionList(fresh, previous, 120)
  assert.equal(merged[0].title, '改过的标题')
  assert.equal(merged[0].time.updated, 5)
  assert.deepEqual(merged.map((item) => item.id), ['a', 'b'])
})

test('合并结果受 limit 封顶，且不会因为 fresh 比 limit 长就被截断', () => {
  const previous = [at('x1', 'X1', 1), at('x2', 'X2', 2)]
  const fresh = [at('n1', 'N1', 9), at('n2', 'N2', 8), at('n3', 'N3', 7)]
  assert.deepEqual(mergeSessionList(fresh, previous, 2).map((i) => i.id), ['n1', 'n2', 'n3'])
  assert.deepEqual(mergeSessionList(fresh, previous, 10).map((i) => i.id), ['n1', 'n2', 'n3', 'x1', 'x2'])
})
