// 真机验收：第三方 API 接入面板。
// 用法：先起 vite dev（建议独立端口 + 临时 USERPROFILE，避免动真实 opencode.json），再
//   node scripts/verify-provider.mjs <cdpPort> [root]
//
// 覆盖的断言：
//   1. 顶栏插头按钮能打开抽屉
//   2. 已有 provider 列表读得到，且**明文 key 不出现在 DOM 里**
//   3. 「DeepSeek 官方」预设把 id / 名称 / 地址填好
//   4. 假 key 会显示上游错误原文（证明真发了请求）
//   5. 真 key 能拉到模型列表并默认全选
//   6. 保存后提示写入成功，并且**真读磁盘**核对：多了这条、其它顶层字段没动
//   7. 额度行：DeepSeek 显示金额（余额 ¥…），没有公开接口的显示「到控制台查看」
import { existsSync, readFileSync } from 'node:fs'

const port = Number(process.argv[2] || 9223)
const root = process.argv[3] || 'F:\\opencode\\workbench'

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('没找到页面目标')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
})
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})

function send(method, params = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || '脚本执行失败')
  }
  return result.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = []
function check(name, ok, detail = '') {
  report.push({ name, ok, detail })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`)
}

async function waitFor(expression, timeoutMs = 30000, step = 400) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(expression)
    if (value) return value
    await sleep(step)
  }
  return null
}

const copy = (text) => `document.querySelector('.provider-panel').textContent`
const btnByText = (text) =>
  `[...document.querySelectorAll('.provider-panel button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`

// 1. 设置工作区根（没有 root 时看到的是引导页，顶栏仍在，但截图不直观）
const rootNow = await evaluate(`localStorage.getItem('oc-workbench:root')`)
if (rootNow !== root) {
  await evaluate(`localStorage.setItem('oc-workbench:root', ${JSON.stringify(root)})`)
  await send('Page.reload', { ignoreCache: true })
  await sleep(4000)
}

await waitFor(`Boolean(document.querySelector('.topbar'))`, 30000)

// 2. 点插头按钮。**必须幂等**：按钮是开关，上一轮验收结束时面板是开着的，
//    再点一次等于把它关掉（实测踩过，表现为「面板没打开」）。
const hasPlug = await evaluate(
  `Boolean([...document.querySelectorAll('.topbar-iconbtn')].find((b) => (b.getAttribute('title') || '').includes('第三方 API 接入')))`,
)
check('顶栏有插头按钮', hasPlug)
const alreadyOpen = await evaluate(`Boolean(document.querySelector('.provider-panel.open'))`)
if (!alreadyOpen) {
  await evaluate(
    `[...document.querySelectorAll('.topbar-iconbtn')].find((b) => (b.getAttribute('title') || '').includes('第三方 API 接入')).click()`,
  )
}

const panelOpen = await waitFor(`Boolean(document.querySelector('.provider-panel.open'))`, 8000)
check('面板打开', Boolean(panelOpen))
if (!panelOpen) {
  const text = await evaluate('document.body.innerText.slice(0, 400)')
  throw new Error(`面板没打开：${text}`)
}

// 3. 等状态读回来（列表或空态任一出现都算读到）
const loaded = await waitFor(
  `!document.querySelector('.provider-empty')?.textContent?.includes('读取中')`,
  15000,
)
check('状态读取完成', Boolean(loaded))

const listText = await evaluate(`document.querySelector('.provider-panel').textContent`)
const leaked = await evaluate(`/sk-[A-Za-z0-9]{16,}/.test(document.querySelector('.provider-panel').textContent)`)
check('列表不含明文 key', leaked === false)
const providerCount = await evaluate(`document.querySelectorAll('.provider-item').length`)
check('读到已有 provider', providerCount > 0, `${providerCount} 条`)

// 4. 三个内置预设 + 图标
const presetCount = await evaluate(`document.querySelectorAll('.provider-preset').length`)
check('三个内置预设都在', presetCount === 3, `数量 ${presetCount}`)
const presetNames = await evaluate(
  `[...document.querySelectorAll('.provider-preset-name')].map((el) => el.textContent)`,
)
check(
  '预设名称正确',
  JSON.stringify(presetNames) === JSON.stringify(['DeepSeek 官方', 'OpenCode Go', 'Command Code']),
  JSON.stringify(presetNames),
)
const iconOk = await evaluate(`[...document.querySelectorAll('.provider-preset img.provider-icon')].every((img) => img.complete && img.naturalWidth > 0)`)
check('三个预设图标都加载成功', iconOk === true)

// 4a. 额度行：真实配置里 deepseek-official 应该有金额，其余提示去控制台
await waitFor(`document.querySelectorAll('.provider-item-quota').length > 0`, 20000)
const quotaLines = await evaluate(
  `[...document.querySelectorAll('.provider-item-quota')].map((el) => el.textContent)`,
)
check(
  '额度行渲染了（金额或控制台提示）',
  Array.isArray(quotaLines) && quotaLines.some((text) => /余额 |控制台/.test(text || '')),
  JSON.stringify(quotaLines),
)
const hasBalance = await evaluate(
  `[...document.querySelectorAll('.provider-item-quota')].some((el) => /余额 ¥/.test(el.textContent))`,
)
check('DeepSeek 显示真实余额', hasBalance === true, hasBalance ? '' : '（没配 deepseek 时可为空）')

// 4b. DeepSeek 官方预设
await evaluate(
  `[...document.querySelectorAll('.provider-preset')].find((b) => b.textContent.includes('DeepSeek 官方')).click()`,
)
await sleep(300)
const preset = await evaluate(`(() => {
  const inputs = [...document.querySelectorAll('.provider-panel .provider-input')]
  return { id: inputs[0]?.value, name: inputs[1]?.value, base: inputs[2]?.value }
})()`)
check(
  '预设填好 id / 名称 / 地址',
  preset.id === 'deepseek-official' &&
    preset.name === 'DeepSeek 官方' &&
    preset.base === 'https://api.deepseek.com/v1',
  JSON.stringify(preset),
)

// 5. 假 key → 应该看到上游 401 原文
//    按顺序取第 4 个 input（ID / 名称 / 地址 / Key）；nth-of-type 在 label 结构里不可靠。
await evaluate(`(() => {
  const inputs = [...document.querySelectorAll('.provider-panel .provider-input')]
  const el = inputs[3]
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, 'sk-deadbeefdeadbeefdeadbeefdeadbeef')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await evaluate(`${btnByText('获取模型')}.click()`)
const badMessage = await waitFor(
  `document.querySelector('.provider-panel .provider-message')?.textContent.includes('401')`,
  30000,
)
check('假 key 显示上游 401 原文', Boolean(badMessage), await evaluate(copy()))

// 6. 真 key → 拉模型（key 由调用方通过环境变量传入，脚本本身不打印）
const realKey = process.env.OC_VERIFY_DEEPSEEK_KEY || ''
const readOnly = process.env.OC_VERIFY_READONLY === '1'
if (realKey && !readOnly) {
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('.provider-panel .provider-input')][3]
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(realKey)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await evaluate(`${btnByText('获取模型')}.click()`)
  const gotModels = await waitFor(`document.querySelectorAll('.provider-model').length > 0`, 45000)
  const count = await evaluate(`document.querySelectorAll('.provider-model').length`)
  const checked = await evaluate(`document.querySelectorAll('.provider-model input:checked').length`)
  check('真 key 拉到模型', Boolean(gotModels), `共 ${count} 个`)
  check('首次拉取默认全选', count > 0 && checked === count, `${checked}/${count}`)

  // 7. 保存 → 提示 + 磁盘
  await evaluate(`${btnByText('保存')}.click()`)
  const saved = await waitFor(
    `document.querySelector('.provider-panel .provider-message')?.textContent.includes('已写入配置')`,
    20000,
  )
  check('保存后提示已写入', Boolean(saved), await evaluate(copy()))

  // 真读磁盘：界面提示可能是假的，只有文件内容才是证据。
  // dev 的 /local/provider 不需要 token，直接问它配置文件路径。
  const origin = new URL(page.url).origin
  const ocToken = await evaluate('window.__OC_TOKEN || ""')
  const status = await (
    await fetch(`${origin}/local/provider/status`, {
      headers: ocToken ? { 'x-oc-token': ocToken } : undefined,
    })
  ).json()
  const configPath = status.path
  const disk = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null
  check('配置文件存在', Boolean(disk), configPath)
  if (disk) {
    const entry = disk.provider?.deepseek
    check(
      '磁盘上写入了 provider 与模型',
      Boolean(entry) && entry.options?.baseURL === 'https://api.deepseek.com/v1' && Boolean(entry.models?.['deepseek-v4-pro']),
      JSON.stringify({ keys: Object.keys(entry || {}) }),
    )
    check(
      '其它顶层字段没被动',
      disk.model === 'purge/deepseek-flash' &&
        Boolean(disk.mcp) &&
        Array.isArray(disk.instructions) &&
        Boolean(disk.provider?.keepme),
      JSON.stringify(Object.keys(disk)),
    )
    check(
      '写进去的不是掩码而是真 key',
      typeof entry?.options?.apiKey === 'string' &&
        entry.options.apiKey.length > 12 &&
        !entry.options.apiKey.includes('…'),
      entry?.options?.apiKey ? `长度 ${entry.options.apiKey.length}` : '缺 key',
    )
  }
} else {
  process.stdout.write(
    readOnly ? 'SKIP  写盘相关（只读模式）\n' : 'SKIP  真 key 相关的两条（没传 OC_VERIFY_DEEPSEEK_KEY）\n',
  )
}

const failed = report.filter((item) => !item.ok)
process.stdout.write(`\n${report.length - failed.length}/${report.length} PASS\n`)
// 先关 WS 并等一拍再退出：边关边 process.exit 会触发 libuv 的
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"，把退出码带成 1。
try {
  ws.close()
} catch {
  // 已关闭
}
await new Promise((resolve) => setTimeout(resolve, 80))
process.exit(failed.length ? 1 : 0)
