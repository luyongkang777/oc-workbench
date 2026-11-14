# 远程访问的反向隧道：把本机 workbench 端口挂到服务器的回环 17801。
# 断了由 tunnel-watchdog.ps1 负责重连；本脚本自己重复调用是安全的（已在跑就跳过）。
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root '.tmp'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
$log = Join-Path $logDir 'remote-tunnel.log'
$errLog = Join-Path $logDir 'remote-tunnel.stderr.log'

function Write-Log([string]$text) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
    Add-Content -Path $log -Value $line -Encoding UTF8
}

$localPort = 17800
$relayPort = 17801
$hostAlias = 'tiku'

# 判活按命令行匹配，不要只看端口：端口会被别的程序抢占（实测踩过）。
$existing = Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" |
    Where-Object { $_.CommandLine -like "*127.0.0.1:$relayPort*" }
if ($existing) {
    Write-Log "隧道已在运行（pid=$($existing.ProcessId)），跳过"
    exit 0
}

$ssh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
if (-not (Test-Path $ssh)) { Write-Log "找不到 ssh.exe：$ssh"; exit 1 }

# Windows 上必须传数组，拼字符串会被引号搞坏。
$sshArgs = @(
    '-N', '-T',
    '-o', 'BatchMode=yes',
    # 换机器/重装后 host key 会变，accept-new 让第一次能连上而不是直接死掉。
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
    '-R', "127.0.0.1:${relayPort}:127.0.0.1:${localPort}",
    $hostAlias
)

# 把 stderr 单独落盘：认证失败/host key 变更这类错误只出现在 stderr，
# 不采集的话现象永远是「进程起来又没了」，无从排查。
Start-Process -FilePath $ssh -ArgumentList $sshArgs -WindowStyle Hidden `
    -RedirectStandardError $errLog
Write-Log "已启动隧道 服务器127.0.0.1:$relayPort -> 本机127.0.0.1:$localPort（stderr: $errLog）"
