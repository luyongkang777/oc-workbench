// 把 shell/icon.ico 写进 exe 的图标资源（RT_ICON + RT_GROUP_ICON）。
//
// 为什么不用 winres / embed-resource：它们都要求机器上有 Windows SDK 的 rc.exe，
// 这台机器没有。Win32 的 BeginUpdateResource/UpdateResource 属于 kernel32，
// 任何 Windows 都能调，改完图标不需要重新编译 Rust。
//
// 用法：node scripts/embed-exe-icon.mjs [exe路径]
// 默认目标：shell/target/release/oc-workbench-shell.exe
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const icoPath = path.join(root, 'shell', 'icon.ico')
const exePath = path.resolve(process.argv[2] ?? path.join(root, 'shell', 'target', 'release', 'oc-workbench-shell.exe'))
const tmpDir = path.join(root, '.tmp')

if (!existsSync(icoPath)) {
  console.log(`✗ 找不到 ${icoPath}，先生成图标`)
  process.exit(1)
}
if (!existsSync(exePath)) {
  console.log(`✗ 找不到 exe：${exePath}`)
  process.exit(1)
}

/** 解析 ICO：返回每张图的尺寸与 PNG 字节 */
function parseIco(buf) {
  const count = buf.readUInt16LE(4)
  const images = []
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16
    const w = buf.readUInt8(at) || 256
    const h = buf.readUInt8(at + 1) || 256
    const bytes = buf.readUInt32LE(at + 8)
    const offset = buf.readUInt32LE(at + 12)
    images.push({ size: w, height: h, data: buf.subarray(offset, offset + bytes) })
  }
  return images
}

const images = parseIco(readFileSync(icoPath))
mkdirSync(tmpDir, { recursive: true })

const payload = {
  exe: exePath,
  images: images.map((img) => ({ size: img.size, height: img.height, b64: img.data.toString('base64') })),
}
const jsonPath = path.join(tmpDir, 'icon-embed.json')
writeFileSync(jsonPath, JSON.stringify(payload), 'utf8')

const psPath = path.join(tmpDir, 'embed-icon.ps1')
writeFileSync(
  psPath,
  String.raw`
$ErrorActionPreference = 'Stop'
$json = Get-Content -Raw -Encoding UTF8 $args[0] | ConvertFrom-Json

Add-Type -Namespace Win32Icon -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
'@

$h = [Win32Icon.Native]::BeginUpdateResource($json.exe, $false)
if ($h -eq [IntPtr]::Zero) { throw "BeginUpdateResource failed: $([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message)" }

$blobs = @()
$id = 1
foreach ($img in $json.images) {
  $bytes = [Convert]::FromBase64String($img.b64)
  $blobs += ,@{ Id = $id; Size = [int]$img.size; Height = [int]$img.height; Bytes = $bytes }
  $ok = [Win32Icon.Native]::UpdateResource($h, [IntPtr]3, [IntPtr]$id, 0, $bytes, [uint32]$bytes.Length)
  if (-not $ok) { [Win32Icon.Native]::EndUpdateResource($h, $true) | Out-Null; throw "UpdateResource(RT_ICON $id) failed" }
  $id++
}

# GRPICONDIR：14 字节头 + 每张图 14 字节条目
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$blobs.Count)
foreach ($b in $blobs) {
  $bw.Write([byte]($(if ($b.Size -ge 256) { 0 } else { $b.Size })))
  $bw.Write([byte]($(if ($b.Height -ge 256) { 0 } else { $b.Height })))
  $bw.Write([byte]0)
  $bw.Write([byte]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]32)
  $bw.Write([uint32]$b.Bytes.Length)
  $bw.Write([uint16]$b.Id)
}
$bw.Flush()
$group = $ms.ToArray()
$bw.Dispose(); $ms.Dispose()

$ok = [Win32Icon.Native]::UpdateResource($h, [IntPtr]14, [IntPtr]1, 0, $group, [uint32]$group.Length)
if (-not $ok) { [Win32Icon.Native]::EndUpdateResource($h, $true) | Out-Null; throw 'UpdateResource(RT_GROUP_ICON) failed' }

if (-not [Win32Icon.Native]::EndUpdateResource($h, $false)) { throw 'EndUpdateResource failed' }
Write-Output "OK $($blobs.Count) images"
`,
  'utf8',
)

const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath, jsonPath], {
  encoding: 'utf8',
})
if (res.status !== 0) {
  console.log(res.stdout ?? '')
  console.log(res.stderr ?? '')
  process.exit(1)
}
console.log(`✓ 图标已写入 ${path.basename(exePath)}：${res.stdout.trim()}`)
