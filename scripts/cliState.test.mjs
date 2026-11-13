// OpenCode CLI 界面文案的回归测试：node --experimental-strip-types --test scripts/cliState.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cliActionLabel,
  cliCanInstall,
  cliFresh,
  cliProgress,
  cliStateLabel,
  cliTag,
  cliVersionHint,
  formatBytes,
} from '../src/components/cliState.ts'

/** 一个「已装 v2.2.5、最新 v2.2.7」的基准状态，测试里按需覆盖字段。 */
const base = (patch = {}) => ({
  supported: true,
  installed: true,
  path: 'C:\\Users\\me\\.opencode\\bin\\opencode.exe',
  version: '2.2.5',
  latest: '2.2.7',
  newer: true,
  size: 124794067,
  notes: '',
  url: 'https://example/x64.zip',
  autoUpdate: true,
  busy: false,
  phase: '',
  done: 0,
  total: 0,
  error: null,
  ...patch,
})

test('formatBytes 用 MB/GB 两级，空值不显示', () => {
  assert.equal(formatBytes(0), '')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2 KB')
  assert.equal(formatBytes(124794067), '119.0 MB')
  assert.equal(formatBytes(3 * 1024 ** 3), '3.00 GB')
})

test('胶囊标记：装了显示版本，没装显示 oc 未装，状态未知不占位', () => {
  assert.equal(cliTag(null), null)
  assert.equal(cliTag(base()), 'oc 2.2.5')
  assert.equal(cliTag(base({ installed: false, version: null })), 'oc 未装')
  assert.equal(cliTag(base({ installed: false, supported: false })), 'oc 缺失')
  // 装了但版本读不出来：不能假装成正常版本
  assert.equal(cliTag(base({ version: null })), 'oc ?')
})

test('胶囊高亮只看「要不要装/更新」', () => {
  assert.equal(cliFresh(null), false)
  assert.equal(cliFresh(base()), true)
  assert.equal(cliFresh(base({ newer: false })), false)
})

test('状态文案区分未安装 / 读不到版本 / 正常', () => {
  assert.equal(cliStateLabel(null), '读取中…')
  assert.equal(cliStateLabel(base({ installed: false, version: null })), '未安装')
  assert.equal(
    cliStateLabel(base({ installed: false, version: null, supported: false })),
    '未安装（本平台不支持自动安装）',
  )
  assert.equal(cliStateLabel(base({ version: null })), '已安装，版本读取失败')
  assert.equal(cliStateLabel(base()), 'v2.2.5')
})

test('按钮文案：下载并安装 / 更新到 vX / 已是最新 / 处理中', () => {
  assert.equal(cliActionLabel(null), '安装')
  assert.equal(cliActionLabel(base({ installed: false, version: null })), '下载并安装')
  assert.equal(cliActionLabel(base()), '更新到 v2.2.7')
  assert.equal(cliActionLabel(base({ newer: false })), '已是最新')
  assert.equal(cliActionLabel(base({ busy: true })), '处理中…')
  assert.equal(cliActionLabel(base({ supported: false })), '仅 Windows 支持')
})

test('按钮可用性：装/更新中、非 Windows、已最新都点不了', () => {
  assert.equal(cliCanInstall(null), false)
  assert.equal(cliCanInstall(base()), true)
  assert.equal(cliCanInstall(base({ installed: false, version: null })), true)
  assert.equal(cliCanInstall(base({ busy: true })), false)
  assert.equal(cliCanInstall(base({ supported: false })), false)
  assert.equal(cliCanInstall(base({ newer: false })), false)
})

test('进度：有总大小才给百分比，没给就只显示阶段', () => {
  assert.equal(cliProgress(null), null)
  assert.equal(cliProgress(base()), null) // 不在安装
  const half = cliProgress(base({ busy: true, done: 100, total: 200, phase: '下载 v2.2.7' }))
  assert.equal(half.percent, 50)
  assert.match(half.text, /下载 v2\.2\.7/)
  assert.match(half.text, /50%/)
  // done 超过 total（服务端给了错的 size）也不能画出 >100%
  const over = cliProgress(base({ busy: true, done: 300, total: 200 }))
  assert.equal(over.percent, 100)
  const unknown = cliProgress(base({ busy: true, done: 12, total: 0, phase: '解压安装包' }))
  assert.equal(unknown.percent, null)
  assert.equal(unknown.text, '解压安装包')
})

test('版本读取失败时给出可操作提示：193 指向脚本包装，其余透出后端原因', () => {
  // 正常情况没有提示
  assert.equal(cliVersionHint(base()), null)
  assert.equal(cliVersionHint(null), null)
  assert.equal(cliVersionHint(base({ installed: false, version: null })), null)

  // 193 / Win32：这是 npm 无扩展名 shim 被当成 exe 的典型报错
  const shim = base({
    version: null,
    error: '启动 C:\\x\\opencode 失败：%1 不是有效的 Win32 应用程序。 (os error 193)',
  })
  assert.match(cliVersionHint(shim) ?? '', /脚本包装/)
  assert.match(cliVersionHint(shim) ?? '', /装成 \.exe/)

  // 其他原因原样透出，不自己编
  const timeout = base({ version: null, error: 'opencode --version 超过 30 秒没返回' })
  assert.equal(cliVersionHint(timeout), 'opencode --version 超过 30 秒没返回')

  // 没给原因时返回 null（不显示空提示条）
  assert.equal(cliVersionHint(base({ version: null, error: null })), null)
})
