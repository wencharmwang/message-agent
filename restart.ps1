# One-click restart of message-agent services.
# Usage: run in PowerShell  ->  .\restart.ps1
$ErrorActionPreference = 'SilentlyContinue'
# 路径全部**推导**，不写死任何人的用户名（这是别人也会用的脚本）。
#   $AgentRoot   = 本脚本所在目录（仓库根）
#   $RuntimeRoot = 同级目录 ..\messaging-runtime；放别处就用环境变量覆盖
$AgentRoot   = $PSScriptRoot
$RuntimeRoot = $env:MESSAGING_RUNTIME_ROOT
if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path (Split-Path $PSScriptRoot -Parent) 'messaging-runtime' }
if (-not (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'tools\start_shared_runtime.py'))) {
  Write-Host ("找不到 messaging-runtime：{0}" -f $RuntimeRoot) -ForegroundColor Red
  Write-Host '请把两个仓库并排放，或用环境变量 MESSAGING_RUNTIME_ROOT 指向它。' -ForegroundColor Yellow
  exit 1
}
$Pythonw     = Join-Path $RuntimeRoot 'runtime\python\pythonw.exe'

# Readiness is decided by the harness health endpoint, not by netstat.
# netstat only proves *something* holds the port; it does not prove the plugin
# answered, and every restart left supervisors racing for 8766 so a listener
# could be a stale host from a window station that cannot see user windows.
# Observed on 2026-09-30: all three ports were LISTENING and the app worked,
# yet restart.ps1 still printed the failure line.
$HealthUrl   = 'http://127.0.0.1:3080/message-agent/health'
$TokenFile   = Join-Path $AgentRoot 'data\control.token'

function Get-ControlToken {
  if (-not (Test-Path -LiteralPath $TokenFile)) { return $null }
  return (Get-Content -LiteralPath $TokenFile -Raw).Trim()
}

function Test-ServiceReady {
  param([string]$Token)
  if (-not $Token) { return $false }
  try {
    $response = Invoke-WebRequest -Uri $HealthUrl -Method GET `
      -Headers @{ Authorization = "Bearer $Token" } -UseBasicParsing -TimeoutSec 3
    return ((ConvertFrom-Json $response.Content).ready -eq $true)
  } catch { return $false }
}

# Returns $true if a process is listening. Uses Get-NetTCPConnection when
# available: it avoids spawning netstat on every poll and, unlike
# `netstat | Select-String`, cannot be defeated by PowerShell collapsing a
# single match into a scalar instead of an array.
function Test-PortListening {
  param([int]$Port)
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($null -ne $connection) { return $true }
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) { return $false }
  # Windows without the NetTCPIP module: fall back to netstat, matched as text.
  return [bool]((netstat -ano | Select-String -SimpleMatch ":$Port ") |
                Where-Object { $_.Line -match 'LISTENING' })
}

Write-Host '[1/4] stopping old services ...'
function Stop-LocalListener([int]$Port, [string[]]$AllowedNames) {
  $pids = (netstat -ano | Select-String 'LISTENING' | Select-String (':' + $Port + ' ')) | ForEach-Object {
    ($_ -replace '^\s+', '') -split '\s+' | Select-Object -Last 1
  } | Sort-Object -Unique
  foreach ($processId in $pids) {
    if ($processId -notmatch '^\d+$') { continue }
    $process = Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue
    if ($process -and $AllowedNames -contains $process.ProcessName) {
      Stop-Process -Id $process.Id -Force
    }
  }
}
Stop-LocalListener 3080 @('node')
Stop-LocalListener 8767 @('python', 'pythonw')
Stop-LocalListener 8766 @('dotnet')
# Supervisors are separate processes from the listeners above, and once another host
# owns port 8766 they only idle instead of exiting, so they pile up as orphans every
# time the launching shell closes. A stale supervisor is not harmless: it can win the
# race for 8766 and host from a window station that cannot see user windows, so every
# read fails with provider_unavailable while it holds the port. Retire them all first.
# 注：这条调用原来写的是 runtime\pythonw.exe（少了 python\ 那一层）—— 路径不存在，
# 配合上面的 SilentlyContinue，等于**从来没清过孤儿 supervisor**，正是下面注释警告的那个隐患。
& (Join-Path $RuntimeRoot 'runtime\python\pythonw.exe') (Join-Path $AgentRoot 'reap-supervisors.py')
Start-Sleep -Seconds 2

Write-Host '[2/4] starting messaging-runtime ...'
Start-Process -FilePath $Pythonw -ArgumentList (Join-Path $RuntimeRoot 'tools\start_shared_runtime.py'), '--supervise' -WindowStyle Hidden

Write-Host '[3/4] starting harness + worker ...'
Start-Process -FilePath $Pythonw -ArgumentList (Join-Path $AgentRoot 'launch.py') -WorkingDirectory $AgentRoot -WindowStyle Hidden

Write-Host '[4/4] waiting for readiness ...'
$token = Get-ControlToken
if (-not $token) { Write-Host ("   warn: missing " + $TokenFile + ' - falling back to port checks') }

$deadline = (Get-Date).AddSeconds(60)
$ready = $false
$portState = @{ 8766 = $false; 8767 = $false; 3080 = $false }
while ((Get-Date) -lt $deadline) {
  foreach ($port in 8766, 8767, 3080) { $portState[$port] = Test-PortListening $port }
  if ($token) {
    if (Test-ServiceReady $token) { $ready = $true; break }
  } elseif ($portState[3080] -and $portState[8766] -and $portState[8767]) {
    $ready = $true; break
  }
  Start-Sleep -Milliseconds 800
}

if (-not $ready) {
  $missing = @(8766, 8767, 3080 | Where-Object { -not $portState[$_] })
  if ($missing.Count) {
    Write-Host ('Startup failed: nothing listening on ' + ($missing -join ', ') +
                '. runtime=8766 harness=3080 worker=8767') -ForegroundColor Red
  } elseif ($token) {
    Write-Host 'Startup failed: ports 8766/3080/8767 are listening but the harness health check never reported ready.' -ForegroundColor Red
    Write-Host '  The likely cause is a stale supervisor hosting port 8766 from a desktop that cannot see user windows.' -ForegroundColor Red
  } else {
    Write-Host 'Startup failed: the harness health check never reported ready.' -ForegroundColor Red
  }
  Write-Host 'Check harness.log and .runtime-data\shared-service.log, then rerun this script.' -ForegroundColor Yellow
  exit 1
}

Write-Host 'Services are ready.'
# The log line already reads `dsh web: http://...`, so strip the prefix instead
# of printing it twice.
$tokenLine = Get-Content (Join-Path $AgentRoot 'harness.log') -Tail 60 | Select-String 'dsh web:' | Select-Object -Last 1
if ($tokenLine) { Write-Host ('Web: ' + ($tokenLine.Line -replace '^\s*dsh web:\s*', '').Trim()) }
elseif ($token) { Write-Host ('Web: http://127.0.0.1:3080/?token=' + $token) }
Write-Host 'Ports: runtime=8766  harness=3080  worker=8767'
