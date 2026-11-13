// 一条命令改版本号：node scripts/bump-version.mjs <版本> [--tag] [--keep-notes] [--dry-run]
//
// 为什么需要它：版本号散在三个地方——package.json（前端 / latest.json 用）、
// shell/Cargo.toml（二进制里 CURRENT_VERSION 用）、shell/Cargo.lock（cargo 会写）。
// 手改很容易漏一处，而漏了的后果很安静：tag 和装出来的版本对不上，
// 客户端会一直「已是最新」。
//
// 顺带把 RELEASE_NOTES.md 生成成草稿（按上个 tag 之后的提交），省得每次现编。

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pkgPath = path.join(root, 'package.json')
const tomlPath = path.join(root, 'shell', 'Cargo.toml')
const lockPath = path.join(root, 'shell', 'Cargo.lock')
const notesPath = path.join(root, 'RELEASE_NOTES.md')
/** Cargo.lock 里这个包的 name，定位版本行用。 */
const CRATE_NAME = 'oc-workbench-shell'

// ---------------------------------------------------------------------------
// 纯函数（可单测，见 scripts/bumpVersion.test.mjs）
// ---------------------------------------------------------------------------

/** `1.2.3` → `{ major: 1, minor: 2, patch: 3 }`；不合法返回 null。 */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * 算出下一版。`patch` / `minor` / `major` 走语义化递增；
 * 直接给版本号则原样采用（只校验格式）。
 */
export function nextVersion(current, input) {
  const base = parseVersion(current)
  if (!base) throw new Error(`当前版本号不合法：${current}`)
  const kind = String(input ?? '').trim().toLowerCase()
  if (kind === 'patch') return `${base.major}.${base.minor}.${base.patch + 1}`
  if (kind === 'minor') return `${base.major}.${base.minor + 1}.0`
  if (kind === 'major') return `${base.major + 1}.0.0`
  const explicit = parseVersion(kind)
  if (!explicit) throw new Error(`版本参数不合法：${input}（可用 patch / minor / major 或 1.2.3）`)
  return `${explicit.major}.${explicit.minor}.${explicit.patch}`
}

/** 只改 package.json 的 version，其余字段与缩进保持不变（2 空格，与现有文件一致）。 */
export function bumpPackageJson(raw, version) {
  const data = JSON.parse(raw)
  data.version = version
  return `${JSON.stringify(data, null, 2)}\n`
}

/** Cargo.toml 里只替换 `[package]` 下的第一个 version 行。 */
export function bumpCargoToml(raw, version) {
  const match = /^version = "[^"]*"$/m.exec(raw)
  if (!match) throw new Error('Cargo.toml 里没找到 version 行')
  return raw.replace(/^version = "[^"]*"$/m, `version = "${version}"`)
}

/** Cargo.lock 里定位 `name = "oc-workbench-shell"` 之后紧跟的 version。 */
export function bumpCargoLock(raw, version, crateName = CRATE_NAME) {
  const block = new RegExp(`(name = "${crateName}"\\r?\\nversion = ")[^"]*(")`)
  if (!block.test(raw)) throw new Error(`Cargo.lock 里没找到 ${crateName} 的版本块`)
  return raw.replace(block, `$1${version}$2`)
}

/** 从提交标题生成 notes 草稿：过滤掉合并与纯 chore，避免把噪音写进更新说明。 */
export function draftNotes(subjects, version) {
  const useful = subjects
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Merge /i.test(line))
    .filter((line) => !/^(chore|docs|ci|test)(\(|:)/i.test(line))
  const bullets = useful.length > 0 ? useful : ['（这次没有面向用户的改动）']
  return [
    `<!-- 发版前改这里：给用户看的一句话，会出现在更新面板里 -->`,
    `- 版本 ${version}`,
    '',
    '<!-- 以下按上个 tag 之后的提交自动生成，删掉不需要的、改写说人话 -->',
    ...bullets.map((line) => `- ${line}`),
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
}

function lastTag() {
  try {
    return git(['describe', '--tags', '--abbrev=0'])
  } catch {
    return ''
  }
}

function commitsSince(tag) {
  const range = tag ? [`${tag}..HEAD`] : ['HEAD']
  try {
    return git(['log', '--no-merges', '--pretty=%s', ...range]).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function main() {
  const argv = process.argv.slice(2)
  const flags = new Set(argv.filter((item) => item.startsWith('--')))
  const positional = argv.filter((item) => !item.startsWith('--'))
  const dryRun = flags.has('--dry-run')
  const withTag = flags.has('--tag')
  const keepNotes = flags.has('--keep-notes')

  if (positional.length === 0) {
    process.stdout.write(
      '用法：npm run bump -- patch|minor|major|1.2.3 [--tag] [--keep-notes] [--dry-run]\n',
    )
    process.exit(1)
  }

  const pkgRaw = readFileSync(pkgPath, 'utf8')
  const tomlRaw = readFileSync(tomlPath, 'utf8')
  const lockRaw = readFileSync(lockPath, 'utf8')
  const pkg = JSON.parse(pkgRaw)
  const tomlVersion = /^version = "([^"]*)"/m.exec(tomlRaw)?.[1] ?? ''
  const lockVersion =
    new RegExp(`name = "${CRATE_NAME}"\\r?\\nversion = "([^"]*)"`).exec(lockRaw)?.[1] ?? ''

  // 三处必须一致：不一致说明上次改漏了，先修好再发版。
  if (pkg.version !== tomlVersion || tomlVersion !== lockVersion) {
    process.stdout.write(
      `✗ 版本号不一致：package.json=${pkg.version} Cargo.toml=${tomlVersion} Cargo.lock=${lockVersion}\n` +
        '  先用 git checkout 恢复，或手工对齐后再 bump。\n',
    )
    process.exit(1)
  }

  let version
  try {
    version = nextVersion(pkg.version, positional[0])
  } catch (err) {
    process.stdout.write(`✗ ${err.message}\n`)
    process.exit(1)
  }

  const tag = `v${version}`
  process.stdout.write(`当前版本 ${pkg.version} → 新版本 ${version}（tag ${tag}）\n`)

  if (dryRun) {
    process.stdout.write('（--dry-run：不写文件）\n')
    return
  }

  writeFileSync(pkgPath, bumpPackageJson(pkgRaw, version), 'utf8')
  writeFileSync(tomlPath, bumpCargoToml(tomlRaw, version), 'utf8')
  writeFileSync(lockPath, bumpCargoLock(lockRaw, version), 'utf8')
  process.stdout.write('✓ 已更新 package.json / shell/Cargo.toml / shell/Cargo.lock\n')

  if (keepNotes) {
    process.stdout.write('· 保留现有 RELEASE_NOTES.md（--keep-notes）\n')
  } else {
    const previous = lastTag()
    const subjects = commitsSince(previous)
    writeFileSync(notesPath, draftNotes(subjects, version), 'utf8')
    process.stdout.write(
      `✓ 已生成 RELEASE_NOTES.md 草稿（基于 ${previous || '首个提交'} 之后的 ${subjects.length} 条提交）\n`,
    )
  }

  if (withTag) {
    try {
      git(['tag', tag])
      process.stdout.write(`✓ 已创建本地 tag ${tag}\n`)
    } catch (err) {
      process.stdout.write(`! 创建 tag 失败（可能已存在）：${err.message}\n`)
    }
  }

  process.stdout.write(
    [
      '',
      '接下来：',
      '  1. 改 RELEASE_NOTES.md（第一条是给用户看的一句话）',
      `  2. git add -A && git commit -m "release: ${version}"`,
      withTag ? `  3. git push origin HEAD:main --tags` : `  3. git tag ${tag} && git push origin HEAD:main --tags`,
      '',
    ].join('\n'),
  )
}

// 被 test 直接 import 时不执行 CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
