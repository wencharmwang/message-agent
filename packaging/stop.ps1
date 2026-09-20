<#
  停止消息助手。

  两件事都要做：停计划任务，**再按命令行精确清掉本产品的残留进程**。
  只做前者会踩一个坑：任务实例早已结束、进程还活着时，Stop-ScheduledTask 杀不掉它们，
  下次启动的新实例抢不到端口/锁，界面看起来"重启了但没生效"（实测踩过）。
  注意：只清属于本产品安装目录的进程，不动消息服务（Messaging Runtime）。
#>
param([switch]$Quiet)

$InstallDir = $PSScriptRoot
$TaskName = 'Message Agent'
$configPath = Join-Path $InstallDir 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) { Write-Host '找不到 config.json，请先运行安装程序。' -ForegroundColor Red; exit 1 }
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

$killed = @()
# ⚠️ 只按"本安装目录 / 本安装的配置路径 / 本安装的 harness home"匹配。
# 绝不要按模块名（比如 agent_worker）匹配 —— 那会把**另一个**正在运行的实例一起杀掉
# （实测事故：装测试实例时把生产实例的 worker 杀了，连带监护进程自毁）。
$mine = @(
  [regex]::Escape($InstallDir),
  [regex]::Escape($configPath),
  [regex]::Escape([string]$config.harness_home)
)
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($mine | Where-Object { $_.CommandLine -match $_ }) } |
  ForEach-Object {
    $killed += "$($_.ProcessName)($($_.ProcessId))"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

# 端口是最终判据：进程清掉了端口还占着，说明还有没认出来的实例。
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 400
}

if (-not $Quiet) {
  if ($killed.Count) { Write-Host ("已停止消息助手（清理了 " + ($killed -join '、') + "）。") -ForegroundColor Green }
  else { Write-Host '消息助手本来就没在运行。' -ForegroundColor Green }
}
