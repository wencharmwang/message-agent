# One-click restart of message-agent services.
# Usage: run in PowerShell  ->  .\restart.ps1
$ErrorActionPreference = 'SilentlyContinue'
$RuntimeRoot = 'C:\Users\Wencharm\Documents\projects\messaging-runtime'
$AgentRoot   = 'C:\Users\Wencharm\Documents\projects\message-agent'
$Pythonw     = Join-Path $RuntimeRoot 'runtime\python\pythonw.exe'

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
& (Join-Path $RuntimeRoot 'runtime\python\python.exe') (Join-Path $AgentRoot 'reap-supervisors.py')
Start-Sleep -Seconds 2

Write-Host '[2/4] starting messaging-runtime ...'
Start-Process -FilePath $Pythonw -ArgumentList (Join-Path $RuntimeRoot 'tools\start_shared_runtime.py'), '--supervise' -WindowStyle Hidden

Write-Host '[3/4] starting harness + worker ...'
Start-Process -FilePath $Pythonw -ArgumentList (Join-Path $AgentRoot 'launch.py') -WorkingDirectory $AgentRoot -WindowStyle Hidden

Write-Host '[4/4] waiting for readiness ...'
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  $rt = (netstat -ano | Select-String 'LISTENING' | Select-String ':8766 ')
  $wk = (netstat -ano | Select-String 'LISTENING' | Select-String ':8767 ')
  if ($rt -and $wk) { $ok = $true; break }
}
if (-not $ok) {
  Write-Host 'Startup may be incomplete; check harness.log and .runtime-data/shared-service.log'
} else {
  Write-Host 'Services are ready.'
  $tokenLine = Get-Content (Join-Path $AgentRoot 'harness.log') -Tail 40 | Select-String 'dsh web:' | Select-Object -Last 1
  Write-Host ('Web: ' + $tokenLine.Line)
  Write-Host 'Ports: runtime=8766  harness=3080  worker=8767'
}
