<#
  启动消息助手（普通用户的默认入口）。
    powershell -ExecutionPolicy Bypass -File start.ps1 -Open
  双击安装目录里的 MessageAgent.cmd 就是执行这一句。
#>
param([switch]$Open, [int]$TimeoutSeconds = 75)

$ErrorActionPreference = 'Stop'
$InstallDir = $PSScriptRoot
$TaskName = 'Message Agent'

function Service-Ready {
  param([string]$Token)
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/message-agent/health' `
      -Headers @{ Authorization = "Bearer $Token" } -UseBasicParsing -TimeoutSec 3
    return ((ConvertFrom-Json $response.Content).ready -eq $true)
  } catch { return $false }
}

$config = Get-Content -LiteralPath (Join-Path $InstallDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$tokenPath = $config.control_token_file
if (-not (Test-Path -LiteralPath $tokenPath)) { Write-Host "找不到 $tokenPath，请先运行安装程序。" -ForegroundColor Red; exit 1 }
$token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()

if (Service-Ready $token) {
  Write-Host '消息助手已经在运行。' -ForegroundColor Green
} else {
  Write-Host '正在启动消息助手…' -ForegroundColor Cyan
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { Start-ScheduledTask -TaskName $TaskName }
  else {
    # 没有计划任务（比如便携使用）：直接起 launcher，交给它托管进程树。
    $python = Join-Path $InstallDir 'runtimes\python\pythonw.exe'
    Start-Process -FilePath $python -ArgumentList ('"' + (Join-Path $InstallDir 'app\launch.py') + '"') `
      -WorkingDirectory $InstallDir -WindowStyle Hidden
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 800
    if (Service-Ready $token) { break }
  }
  if (Service-Ready $token) { Write-Host '已启动。' -ForegroundColor Green }
  else { Write-Host '启动超时。日志在数据目录的 logs\harness.log：可以双击 restart.ps1 再试一次。' -ForegroundColor Yellow }
}

if ($Open) {
  Start-Process ("http://127.0.0.1:3080/?token=" + $token)
}
