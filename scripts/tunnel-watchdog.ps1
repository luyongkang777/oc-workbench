# 隧道看门狗：每 30 秒巡检一次。
#   隧道进程没了        → 重连（这才是它该干的事）
#   本机服务没起        → 只记一次日志，不重拉隧道（否则日志被噪音刷满）
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root '.tmp'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
$log = Join-Path $logDir 'remote-tunnel.log'

$relayPort = 17801
$localPort = 17800

function Write-Log([string]$text) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
    Add-Content -Path $log -Value $line -Encoding UTF8
}

function Test-Local([int]$port) {
    try {
        $client = New-Object Net.Sockets.TcpClient
        $ok = $client.ConnectAsync('127.0.0.1', $port).Wait(2000) -and $client.Connected
        $client.Close()
        return $ok
    } catch {
        return $false
    }
}

Write-Log "看门狗启动（每 30 秒巡检）"

# 「本机服务没起」只记一次，服务起来后重置。
$warnedLocalDown = $false

while ($true) {
    try {
        $tunnel = Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" |
            Where-Object { $_.CommandLine -like "*127.0.0.1:$relayPort*" }
        $localUp = Test-Local $localPort

        if (-not $tunnel) {
            Write-Log ("隧道不在（本机服务={0}），重连" -f $localUp)
            & (Join-Path $PSScriptRoot 'remote-tunnel.ps1')
        } elseif (-not $localUp) {
            if (-not $warnedLocalDown) {
                Write-Log "隧道在，但本机 $localPort 没在监听：工作台没启动？隧道保持不动"
                $warnedLocalDown = $true
            }
        } else {
            if ($warnedLocalDown) {
                Write-Log "本机 $localPort 已恢复监听"
                $warnedLocalDown = $false
            }
        }
    } catch {
        Write-Log "巡检出错：$($_.Exception.Message)"
    }
    Start-Sleep -Seconds 30
}
