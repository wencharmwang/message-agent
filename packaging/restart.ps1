<#
  重启消息助手。用户遇到"改了设置没生效""页面打不开"时，双击这个脚本就行。
  先停（含残留进程清理）再启动，最后等健康检查。
#>
param([switch]$Open)

$here = $PSScriptRoot
Write-Host '正在重启消息助手…' -ForegroundColor Cyan
& (Join-Path $here 'stop.ps1') -Quiet
Start-Sleep -Seconds 2
& (Join-Path $here 'start.ps1') -Open:$Open
