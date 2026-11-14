# oc-workbench shell diagnostics.
# Pure-ASCII output on purpose: PowerShell 5.1 mis-decodes UTF-8 without BOM.
#
# Easiest run (double-click friendly): use diag-shell.cmd next to this file.
# Manual run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File diag-shell.ps1
#
# Everything is also saved to Desktop\oc-diag-<MMdd-HHmm>.txt.

$ErrorActionPreference = 'SilentlyContinue'

$stamp = Get-Date -Format 'MMdd-HHmm'
$logPath = Join-Path ([Environment]::GetFolderPath('Desktop')) ('oc-diag-' + $stamp + '.txt')
$transcript = $false
try {
    Start-Transcript -Path $logPath -Force | Out-Null
    $transcript = $true
} catch { $transcript = $false }

function Section([string]$title) {
    Write-Output ''
    Write-Output ('=== ' + $title + ' ===')
}

Write-Output 'oc-workbench shell diagnostics'
Write-Output ('time=' + (Get-Date).ToString('s'))
Write-Output ('user=' + $env:USERNAME)

Section 'opencode version'
& opencode --version

Section 'service status'
& opencode service status

Section 'service SHELL  (empty = no fallback injected / powershell.exe = fallback injected)'
& opencode service get env SHELL

Section 'pwsh candidates on PATH (shell of THIS process)'
& where.exe pwsh

Section 'PATH entries containing WindowsApps or PowerShell'
($env:PATH -split ';') | Where-Object { $_ -match 'WindowsApps|PowerShell' }

Section 'pwsh probe: opencode style (-File temp script)'
$probe = Join-Path $env:TEMP ('oc-shell-probe-' + $PID + '.ps1')
'Write-Output "probe-ok"' | Set-Content -Path $probe -Encoding UTF8
& pwsh -NoProfile -ExecutionPolicy Bypass -File $probe
Write-Output ('pwsh_file_exit=' + $LASTEXITCODE)

Section 'pwsh probe: exit 0'
& pwsh -NoProfile -NonInteractive -Command 'exit 0'
Write-Output ('pwsh_exit=' + $LASTEXITCODE)

Section 'Windows PowerShell probe'
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command 'exit 0'
Write-Output ('ps_exit=' + $LASTEXITCODE)

Section 'workbench process / version'
Get-Process | Where-Object { $_.ProcessName -like '*oc-workbench*' } | ForEach-Object {
    Write-Output ('exe=' + $_.Path)
    Write-Output ('started=' + $_.StartTime)
    $vi = (Get-Item $_.Path).VersionInfo
    Write-Output ('filever=' + $vi.FileVersion + ' product=' + $vi.ProductVersion)
    $bytes = [System.IO.File]::ReadAllBytes($_.Path)
    Write-Output ('marker shellprobe=' + [bool](([System.Text.Encoding]::ASCII.GetString($bytes)) -match 'shell-fallback'))
}

Section 'opencode service.json'
$svcPaths = @(
    "$env:USERPROFILE\.local\state\opencode\service.json",
    "$env:LOCALAPPDATA\opencode\service.json",
    "$env:LOCALAPPDATA\state\opencode\service.json",
    "$env:APPDATA\opencode\service.json"
)
$svcJson = $null
foreach ($path in $svcPaths) {
    if (Test-Path $path) {
        Write-Output ('path=' + $path)
        $raw = Get-Content $path -Raw
        Write-Output $raw
        try { $svcJson = $raw | ConvertFrom-Json } catch {}
        break
    }
}

Section 'opencode service process (real exe + cmdline)'
$svcProc = $null
if ($svcJson -and $svcJson.pid) {
    $svcProc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $svcJson.pid)
    if ($svcProc) {
        Write-Output ('pid=' + $svcProc.ProcessId)
        Write-Output ('cmdline=' + $svcProc.CommandLine)
        Write-Output ('exe=' + $svcProc.ExecutablePath)
        Write-Output ('parent=' + $svcProc.ParentProcessId)
        $parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $svcProc.ParentProcessId)
        if ($parent) {
            Write-Output ('parent_cmdline=' + $parent.CommandLine)
        }
    } else {
        Write-Output ('pid ' + $svcJson.pid + ' not running')
    }
} else {
    Write-Output 'no pid in service.json'
}

Section 'workbench projects / root (cwd the shell tool would use)'
$projectPaths = @()
if (Test-Path "$env:LOCALAPPDATA\oc-workbench\root.txt") {
    $rootPath = (Get-Content "$env:LOCALAPPDATA\oc-workbench\root.txt" -Raw).Trim()
    Write-Output ('root=' + $rootPath)
    if ($rootPath) { $projectPaths += $rootPath }
}
if (Test-Path "$env:LOCALAPPDATA\oc-workbench\projects.json") {
    $rawProj = Get-Content "$env:LOCALAPPDATA\oc-workbench\projects.json" -Raw
    Write-Output ('projects=' + $rawProj)
    try {
        $projObj = $rawProj | ConvertFrom-Json
        foreach ($item in @($projObj)) {
            if ($item -is [string]) { $projectPaths += $item }
            elseif ($item.path) { $projectPaths += $item.path }
            elseif ($item.root) { $projectPaths += $item.root }
        }
    } catch {
        Write-Output ('projects parse error: ' + $_.Exception.Message)
    }
}
$projectPaths = $projectPaths | Select-Object -Unique
foreach ($pp in $projectPaths) {
    Write-Output ('exists(' + $pp + ')=' + (Test-Path -LiteralPath $pp))
}

Section 'session cwd from opencode'
Get-ChildItem "$env:LOCALAPPDATA\oc-workbench\sessions" -ErrorAction SilentlyContinue |
    Select-Object -First 3 Name, LastWriteTime

Section 'opencode /api/shell : what shell the server really uses'
$ocExe = $null
if ($svcProc -and $svcProc.ExecutablePath -and (Test-Path $svcProc.ExecutablePath)) {
    $ocExe = $svcProc.ExecutablePath
}
if (-not $ocExe) {
    $cmdInfo = Get-Command opencode -ErrorAction SilentlyContinue
    if ($cmdInfo) {
        $src = $cmdInfo.Source
        if ($src -like '*.exe') {
            $ocExe = $src
        } elseif ($src) {
            Write-Output ('shim=' + $src)
            $line = Get-Content $src | Where-Object { $_ -match '\.exe' } | Select-Object -First 1
            if ($line -match '"([^"]+\.exe)"') { $ocExe = $matches[1] }
            elseif ($line -match '([A-Za-z]:\\[^"]+\.exe)') { $ocExe = $matches[1] }
        }
    }
}
Write-Output ('resolved opencode.exe=' + $ocExe)

function Invoke-Oc([string]$exe, [string]$arguments) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = $arguments
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEnd()
    $err = $p.StandardError.ReadToEnd()
    $p.WaitForExit(30000) | Out-Null
    return @{ out = $out; err = $err }
}

function Test-OcShell([string]$exe, [string]$cwd, [string]$label) {
    Write-Output ''
    Write-Output ('--- probe [' + $label + '] cwd=' + $cwd + ' ---')
    $cwdJson = $cwd.Replace('\', '/')
    $body = '{"command":"Write-Output foreground-ok","cwd":"' + $cwdJson + '"}'
    $escaped = $body.Replace('"', '\"')
    $r = Invoke-Oc $exe ('api POST /api/shell -d "' + $escaped + '"')
    Write-Output ('post_stdout=' + $r.out.Trim())
    Write-Output ('post_stderr=' + $r.err.Trim())

    $created = $null
    try { $created = $r.out.Trim() | ConvertFrom-Json } catch {}
    if (-not ($created -and $created.data -and $created.data.id)) {
        Write-Output 'POST failed - cannot read shell result'
        return
    }
    $id = $created.data.id
    Write-Output ('shell=' + $created.data.shell)
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        $g = Invoke-Oc $exe ('api GET /api/shell/' + $id)
        $state = $null
        try { $state = $g.out.Trim() | ConvertFrom-Json } catch {}
        if ($state -and $state.data -and $state.data.status -ne 'running') {
            Write-Output ('status=' + $state.data.status)
            Write-Output ('exit=' + $state.data.exit)
            if ($state.data.file -and (Test-Path $state.data.file)) {
                Write-Output '--- output (last 20 lines) ---'
                Get-Content $state.data.file -Tail 20
                Write-Output '--- end output ---'
            } else {
                Write-Output ('output file missing: ' + $state.data.file)
            }
            return
        }
    }
    Write-Output 'probe still running after 10s'
}

if ($ocExe) {
    Test-OcShell $ocExe 'C:/Windows/Temp' 'control'
    $existing = $projectPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($existing) {
        Test-OcShell $ocExe $existing 'workbench project'
    } else {
        Write-Output ''
        Write-Output 'no existing workbench project path - skipped project cwd probe'
    }
}

Section 'workbench log: shell related lines (Chinese may look garbled, keywords are ASCII)'
Get-Content "$env:LOCALAPPDATA\oc-workbench\gui-error.log" -Tail 80 |
    Select-String -Pattern 'shell|SHELL|pwsh|PowerShell|fallback'

Section 'done'
if ($transcript) {
    Write-Output ('SAVED TO: ' + $logPath)
} else {
    Write-Output 'transcript unavailable - copy the text above'
}
if ($transcript) { try { Stop-Transcript | Out-Null } catch {} }

Write-Output ''
Write-Output 'Press Enter to close...'
try { Read-Host | Out-Null } catch {}

