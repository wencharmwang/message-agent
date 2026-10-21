<#
  卸载消息助手。

  **默认保留用户数据**（追踪记录、待办、规则、聊天记录派生数据都在数据目录里）。
  要连数据一起删，必须显式加 -RemoveData，而且会再问一次 —— 卸载程序不该顺手删掉
  用户攒下来的东西。

    powershell -ExecutionPolicy Bypass -File uninstall.ps1
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -RemoveData
#>
param(
  # $PSScriptRoot 在 param 默认值里还不可用（PS 5.1），所以进函数体再解析。
  [string]$InstallDir = '',
  [string]$DataDir = '',
  [switch]$RemoveData,
  [switch]$Yes
)

$ErrorActionPreference = 'Continue'
$TaskName = 'Message Agent'
if (-not $InstallDir) { $InstallDir = $PSScriptRoot }

$configPath = Join-Path $InstallDir 'config.json'
if (-not $DataDir -and (Test-Path -LiteralPath $configPath)) {
  try {
    $token = (Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json).control_token_file
    $DataDir = Split-Path (Split-Path $token -Parent) -Parent
  } catch { }
}
if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA 'MessageAgent' }

Write-Host ''
Write-Host '卸载消息助手' -ForegroundColor Cyan
Write-Host "  程序目录：$InstallDir"
Write-Host "  数据目录：$DataDir"

Write-Host '  正在停止…' -ForegroundColor DarkGray
& (Join-Path $InstallDir 'stop.ps1') -Quiet

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host '  已取消开机自启。' -ForegroundColor Green
}
# 数据自动刷新任务是「开始使用」装的（解锁工具侧的 WechatDbSnapshotRefresh，
# 每 5 分钟静默刷新快照）：助手都卸了，刷新它就没意义了，一起清掉。
$refresh = Get-ScheduledTask -TaskName 'WechatDbSnapshotRefresh' -ErrorAction SilentlyContinue
if ($refresh) {
  Unregister-ScheduledTask -TaskName 'WechatDbSnapshotRefresh' -Confirm:$false
  Write-Host '  已取消数据自动刷新。' -ForegroundColor Green
}
$shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) '消息助手.lnk'
if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force; Write-Host '  已删除桌面快捷方式。' -ForegroundColor Green }

if ($RemoveData) {
  Write-Host ''
  Write-Host '  ⚠️ 你要求连数据一起删除：规则、待办、追踪记录、解密缓存都会消失，无法恢复。' -ForegroundColor Red
  if (-not $Yes) {
    $answer = Read-Host '  确认删除数据？输入 DELETE 才会删'
    if ($answer -ne 'DELETE') { $RemoveData = $false; Write-Host '  已保留数据。' -ForegroundColor Green }
  }
}
if ($RemoveData -and (Test-Path -LiteralPath $DataDir)) {
  Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host '  数据目录已删除。' -ForegroundColor Yellow
} else {
  Write-Host "  数据保留在：$DataDir（重新安装会继续用这份数据）" -ForegroundColor Green
}

# 程序目录里有正在运行的脚本自己，直接删会失败 —— 交给一个 detached 进程在退出后清理。
Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden `
  -ArgumentList '/c', ('timeout /t 2 >nul & rmdir /s /q "' + $InstallDir + '"')
Write-Host ''
Write-Host '卸载完成（程序目录会在几秒内自动清掉）。' -ForegroundColor Green
