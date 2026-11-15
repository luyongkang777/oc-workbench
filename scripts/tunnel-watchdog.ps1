# 隧道看门狗：每 30 秒巡检一次。
#   隧道进程没了        → 重连（这才是它该干的事）
#   本机服务没起        → 只记一次日志，不重拉隧道（否则日志被噪音刷满）
param([string]$SshHost = 'tiku')

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root '.tmp'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
$log = Join-Path $logDir 'remote-tunnel.log'

$relayPort = 17801
$localPort = 17800

# 服务器侧是否真的在监听回环端口。只看本机 ssh 进程会被「-R 没绑上」
# 或「端口被别的程序占住」骗过去（tasks.md T8 明确要求这条判据）。
$ssh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
$hasSsh = Test-Path $ssh

function Test-Remote([int]$port) {
    # 三态：$true 在 / $false 明确不在 / $null 无法判定（没 ssh、连不上、没 ss）。
    # 只有「明确不在」才重建：一次偶发超时不该打死一条正在工作的隧道。
    if (-not $hasSsh) { return $null }
    try {
        & $ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 `
            $SshHost "command -v ss >/dev/null 2>&1 || exit 3; ss -lntH | grep -q '127.0.0.1:$port'" 2>$null
        switch ($LASTEXITCODE) {
            0 { return $true }
            3 { return $null }   # 服务器没有 ss：无法判定
            127 { return $null } # 命令找不到
            255 { return $null } # ssh 连不上
            default { return $false }
        }
    } catch {
        return $null
    }
}

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
$remoteFail = 0

while ($true) {
    try {
        $tunnel = Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" |
            Where-Object { $_.CommandLine -like "*127.0.0.1:$relayPort*" }
        $localUp = Test-Local $localPort

        $remoteUp = Test-Remote $relayPort
        if ($tunnel -and $remoteUp -eq $false) {
            $remoteFail = $remoteFail + 1
            Write-Log ("服务器 {0}:{1} 判定不通（第 {2} 次）" -f $SshHost, $relayPort, $remoteFail)
            if ($remoteFail -ge 2) {
                # 连续两次明确不通才重建，单次 ssh 抖动不算。
                $remoteFail = 0
                Write-Log "连续两次不通，重建隧道"
                $tunnel | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
                Start-Sleep -Seconds 2
                & (Join-Path $PSScriptRoot 'remote-tunnel.ps1')
            }
        } elseif (-not $tunnel) {
            $remoteFail = 0
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
