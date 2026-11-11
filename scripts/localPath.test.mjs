// 打开路径归一化的回归测试：node --experimental-strip-types --test scripts/localPath.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeRootPath, splitOpenPath } from '../src/components/localPath.ts'

test('相对路径原样保留，root 不变', () => {
  assert.deepEqual(splitOpenPath('F:\\opencode\\workbench', 'src/App.tsx'), {
    root: 'F:\\opencode\\workbench',
    path: 'src/App.tsx',
  })
  assert.deepEqual(splitOpenPath('F:\\opencode\\workbench', './docs/x.md'), {
    root: 'F:\\opencode\\workbench',
    path: 'docs/x.md',
  })
})

test('工作区内的绝对路径转成相对路径', () => {
  assert.deepEqual(splitOpenPath('F:\\opencode\\workbench', 'F:\\opencode\\workbench\\src\\App.tsx'), {
    root: 'F:\\opencode\\workbench',
    path: 'src/App.tsx',
  })
  // 大小写不敏感（Windows），且反斜杠/正斜杠混写
  assert.deepEqual(splitOpenPath('F:\\opencode\\workbench', 'f:/OPENCODE/workbench/src/App.tsx'), {
    root: 'F:\\opencode\\workbench',
    path: 'src/App.tsx',
  })
  // root 带尾斜杠
  assert.deepEqual(splitOpenPath('F:\\opencode\\workbench\\', 'F:\\opencode\\workbench\\a.md'), {
    root: 'F:\\opencode\\workbench\\',
    path: 'a.md',
  })
})

test('工作区外的绝对路径：root 换成文件所在目录', () => {
  assert.deepEqual(
    splitOpenPath(
      'F:\\opencode\\workbench',
      'C:\\Users\\a1890\\.opencode\\plan\\2026-11-11-vt-debugger-from-scratch.md',
    ),
    {
      root: 'C:/Users/a1890/.opencode/plan',
      path: '2026-11-11-vt-debugger-from-scratch.md',
    },
  )
})

test('Git Bash 风格 /c/... 也归一', () => {
  assert.deepEqual(splitOpenPath('F:\\opencode', '/c/Users/a1890/.opencode/plan/x.md'), {
    root: 'c:/Users/a1890/.opencode/plan',
    path: 'x.md',
  })
})

test('指向 root 本身返回空 path（目录，调用方忽略）', () => {
  assert.equal(splitOpenPath('F:\\opencode', 'F:\\opencode').path, '')
  // 盘符根没有文件名
  assert.equal(splitOpenPath('F:\\opencode', 'C:/').path, '')
})

test('打开文件夹：粘贴的各种写法都规范成 C:\\a\\b', () => {
  assert.equal(normalizeRootPath('C:\\Users\\a1890\\Desktop'), 'C:\\Users\\a1890\\Desktop')
  assert.equal(normalizeRootPath('C:/Users/a1890/Desktop'), 'C:\\Users\\a1890\\Desktop')
  assert.equal(normalizeRootPath('/c/Users/a1890/Desktop'), 'C:\\Users\\a1890\\Desktop')
  assert.equal(normalizeRootPath('file:///C:/Users/a1890/Desktop'), 'C:\\Users\\a1890\\Desktop')
  // 资源管理器「复制路径」带引号
  assert.equal(normalizeRootPath('"C:\\Users\\a1890\\Desktop"'), 'C:\\Users\\a1890\\Desktop')
  // 尾斜杠去掉，但盘符根保留
  assert.equal(normalizeRootPath('C:\\Users\\a1890\\Desktop\\'), 'C:\\Users\\a1890\\Desktop')
  assert.equal(normalizeRootPath('C:\\'), 'C:\\')
  // 空白输入
  assert.equal(normalizeRootPath('   '), '')
})
