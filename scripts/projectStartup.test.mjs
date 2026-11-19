// 启动期项目清单的回归测试：
// node --experimental-strip-types --test scripts/projectStartup.test.mjs
//
// 对应线上 bug：重开工作台后清单只剩第一个文件夹。
// 时间线是：oc:auth → root:<上次目录>（立刻调 applyRoot）→ 几毫秒后 projects:<json>。
// 如果 root: 那时就落盘，磁盘清单会被「只有当前目录」覆盖。
import assert from 'node:assert/strict'
import test from 'node:test'

import { createPersistGate, mergeStartupProjects } from '../src/components/projectStartup.ts'
import { upsertProject } from '../src/components/projectList.ts'

const disk = [
  { path: 'F:\\opencode\\workbench', name: 'workbench', lastUsed: 100, state: { file: 'a.ts', view: 'code' } },
  { path: 'F:\\硬件开发', name: '硬件开发', lastUsed: 90, state: { file: 'tools/x.ps1', view: 'code' } },
]

test('清单读回来之前不落盘，读回来后才写一次', () => {
  const writes = []
  const gate = createPersistGate((list) => writes.push(list))

  // 启动瞬间：root:<path> 触发 applyRoot，内存里只有当前目录
  const memory = upsertProject([], 'F:\\硬件开发')
  gate.save(memory)
  assert.equal(writes.length, 0, '就绪前不能写盘，否则会覆盖掉磁盘上的其它项目')

  // 清单到达：合并后一次性落盘
  const merged = mergeStartupProjects(disk, memory, 'F:\\硬件开发')
  gate.hydrate(merged)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].map((p) => p.name).sort(), ['workbench', '硬件开发'])

  // 之后就绪了，普通改动照常写
  gate.save(merged)
  assert.equal(writes.length, 2)
  assert.equal(gate.isHydrated(), true)
})

test('合并保留磁盘上的界面状态和全部项目', () => {
  // 启动期间页面只认识「硬件开发」（applyRoot 建的，没有 state）
  const memory = upsertProject([], 'F:\\硬件开发')
  const merged = mergeStartupProjects(disk, memory, 'F:\\硬件开发')

  assert.equal(merged.length, 2)
  const workbench = merged.find((p) => p.name === 'workbench')
  assert.equal(workbench.state.file, 'a.ts', '磁盘上记住的文件不能被空项目覆盖')
  const hardware = merged.find((p) => p.name === '硬件开发')
  assert.equal(hardware.state.file, 'tools/x.ps1', '同一路径以磁盘那份为准')
})

test('启动期间新打开、磁盘上没有的项目不会丢', () => {
  const memory = upsertProject([], 'F:\\新项目')
  const merged = mergeStartupProjects(disk, memory, 'F:\\新项目')
  assert.deepEqual(merged.map((p) => p.name).sort(), ['workbench', '新项目', '硬件开发'].sort())
})

test('当前目录不在任何一份清单里时补上', () => {
  const merged = mergeStartupProjects(disk, [], 'F:\\临时目录')
  assert.equal(merged.length, 3)
  assert.ok(merged.some((p) => p.name === '临时目录'))
})

test('没有当前目录时只合并两份清单，不凭空加项目', () => {
  const merged = mergeStartupProjects(disk, [], '')
  assert.equal(merged.length, 2)
})

test('同一路径大小写/斜杠不同也只留一条', () => {
  const merged = mergeStartupProjects(disk, [{ path: 'f:/OPENCODE/workbench/', name: '别的名字' }], '')
  assert.equal(merged.length, 2)
  const hit = merged.find((p) => p.name !== '硬件开发')
  assert.equal(hit.name, 'workbench', '先出现的磁盘条目优先')
})
