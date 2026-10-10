<#
  重启消息助手。

  用户遇到"改了设置没生效""页面打不开"时，跑这个（或双击）就行。
  先停（含残留进程清理）再启动，最后等健康检查。

  两种布局都能用：安装版（脚本在安装目录里）与源码检出（脚本在 packaging\ 下）。
  识别逻辑与 stop.ps1 / start.ps1 一致。
#>
param([switch]$Open, [int]$TimeoutSeconds = 75)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

function Resolve-ProductRoot([string]$start) {
  if (Test-Path -LiteralPath (Join-Path $start 'config.json')) { return $start }
  $parent = Split-Path $start -Parent
  if ($parent -and (Test-Path -LiteralPath (Join-Path $parent 'config.json'))) { return $parent }
  return $start
}

Write-Host ''
Write-Host '正在重启消息助手…' -ForegroundColor Cyan
Write-Host ("   根目录：{0}" -f (Resolve-ProductRoot $here)) -ForegroundColor DarkGray

# 1) 停。**必须先确认停成功了再起** —— 否则旧进程还占着端口，
#    新实例抢不到端口却"看起来启动了"，界面上就是"重启了但没生效"（实测踩过）。
Write-Host '   停止…' -ForegroundColor DarkGray
& (Join-Path $here 'stop.ps1') -Quiet
if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '停止失败，已中止重启（免得留下半死状态）。请按上面提示排查后重试。' -ForegroundColor Red
  exit 1
}

Start-Sleep -Seconds 2

# 2) 起（start.ps1 会自己等健康检查）
& (Join-Path $here 'start.ps1') -Open:$Open -TimeoutSeconds $TimeoutSeconds
exit $LASTEXITCODE
