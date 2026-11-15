# 把本机登记到远程访问网关，显示 8 位配对码。
#
# 用法：右键「使用 PowerShell 运行」，或者
#   powershell -ExecutionPolicy Bypass -File scripts\pair.ps1
#
# 成功后：
#   * 屏幕会显示 8 位配对码（5 分钟有效）
#   * settings.json 里多一个 relayPort（隧道脚本按它连）
# 然后在手机/浏览器里登录网关，输入这个码，就把这台电脑绑到你的账号下。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $PSScriptRoot 'gateway.config.json'
$settingsPath = Join-Path $env:LOCALAPPDATA 'oc-workbench\settings.json'

if (-not (Test-Path $configPath)) {
    Write-Host "缺少 scripts\gateway.config.json（里面有网关地址和注册密钥）" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $settingsPath)) {
    Write-Host "找不到 settings.json：$settingsPath" -ForegroundColor Red
    Write-Host "先启动一次工作台（它会生成 remoteToken / remoteBase），再运行本脚本。" -ForegroundColor Yellow
    exit 1
}

$config = Get-Content $configPath -Raw | ConvertFrom-Json
$settings = Get-Content $settingsPath -Raw | ConvertFrom-Json

if (-not $settings.remoteBase -or -not $settings.remoteToken) {
    Write-Host "settings.json 里没有 remoteBase / remoteToken。" -ForegroundColor Red
    Write-Host "请确认本机是远程访问版本，并且至少启动过一次。" -ForegroundColor Yellow
    exit 1
}

# remoteBase 形如 /u/645a6a9ede23f047，取出设备 ID
$deviceId = ($settings.remoteBase -replace '^/u/', '' -replace '/+$', '')
if (-not $deviceId) {
    Write-Host "remoteBase 格式不对：$($settings.remoteBase)" -ForegroundColor Red
    exit 1
}

$name = $env:COMPUTERNAME
$answer = Read-Host "这台电脑在手机上的显示名（直接回车用 $name）"
if ($answer) { $name = $answer }

$body = @{ id = $deviceId; name = $name; token = $settings.remoteToken } | ConvertTo-Json -Compress
$headers = @{ 'X-Enroll' = $config.enroll }

Write-Host "正在登记到 $($config.url) ..." -ForegroundColor Cyan
try {
    $resp = Invoke-RestMethod -Uri "$($config.url)/portal/api/register" -Method Post `
        -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 20
} catch {
    Write-Host "登记失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# 记下回环端口，隧道脚本按它建转发（不写死 17801）
$settings | Add-Member -NotePropertyName relayPort -NotePropertyValue $resp.port -Force
# 不能用 Set-Content -Encoding UTF8：PowerShell 5.1 会写 UTF-8 BOM，
# 而 Rust 侧 serde_json 不认 BOM —— 重启后整个 settings.json 被当成空配置覆盖，
# remoteBase / relayPort 全丢（远程入口变 404/502）。
$json = $settings | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($settingsPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
if ($resp.bound) {
    Write-Host "这台电脑已经绑定过了，直接打开网关就能看到。" -ForegroundColor Green
} else {
    Write-Host "================ 配对码 ================" -ForegroundColor Green
    Write-Host ("                 {0}" -f $resp.code) -ForegroundColor Yellow
    Write-Host "=======================================" -ForegroundColor Green
    Write-Host "5 分钟内有效。手机打开 $($config.url) 登录后输入这 8 位数字。" -ForegroundColor Cyan
}
Write-Host ""
Write-Host "回环端口：$($resp.port)（已写入 settings.json 的 relayPort，隧道脚本会自动用）" -ForegroundColor Gray
