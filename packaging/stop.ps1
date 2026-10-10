<#
  停止消息助手。

  两种布局都能用（这是用户会点的脚本，所以不能只认安装版）：

    * 安装版：脚本就在安装目录里，config.json 在旁边；
    * 源码检出：脚本在 packaging\ 下，根目录在上一层（config.json 在那里）。

  做三件事：
    1) 停掉计划任务（只有安装版有）；
    2) 按"**本产品根目录**"匹配命令行清进程；
    3) **端口是最终判据** —— 进程清掉后还要等到端口释放，否则说明还有没认出来的实例
       （常见于监护进程把子进程重新拉起）。

  安全约束（踩过的坑，别改）：
    * **绝不按模块名匹配**（比如 agent_worker）—— 会把另一个正在运行的实例一起杀掉。
      实测事故：装测试实例时按模块名清进程，把生产实例的 worker 杀了，连带监护进程自毁。
    * 端口匹配到的进程，只在名字是 python/pythonw/node 时才动，避免误杀别的程序。
#>
param(
  [switch]$Quiet,
  # 只看会停掉哪些进程，不真停。不确定现在跑着什么、或者刚改完配置时先跑这个。
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
function Say($t, $c = 'Gray') { if (-not $Quiet) { Write-Host $t -ForegroundColor $c } }

# ---- 1. 找到"本产品根目录"（安装版 = 脚本所在目录；源码检出 = 上一层）----
function Resolve-ProductRoot([string]$start) {
  if (Test-Path -LiteralPath (Join-Path $start 'config.json')) { return $start }
  $parent = Split-Path $start -Parent
  if ($parent -and (Test-Path -LiteralPath (Join-Path $parent 'config.json'))) { return $parent }
  return $start
}

$here = $PSScriptRoot
$root = Resolve-ProductRoot $here
$configPath = Join-Path $root 'config.json'
$config = $null
if (Test-Path -LiteralPath $configPath) {
  try { $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $config = $null }
}

# 端口：拿不到配置就用默认值（与代码里的默认值一致）
$ports = @(8767, 3080)
if ($config) {
  if ($config.control_port) { $ports[0] = [int]$config.control_port }
  if ($config.harness_port) { $ports[1] = [int]$config.harness_port }
}

Say ''
Say '== 停止消息助手' 'Cyan'
Say ("   根目录：{0}" -f $root) 'DarkGray'
if (-not $config) { Say '   找不到 config.json，端口用默认值 8767 / 3080' 'Yellow' }

# ---- 2. 计划任务（只有安装版会有）----
$TaskName = 'Message Agent'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  if (-not $DryRun) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  Say '   已停计划任务：Message Agent' 'DarkGray'
}

# ---- 3. 按根目录匹配命令行 ----
$mine = @([regex]::Escape($root), [regex]::Escape($configPath))
if ($config -and $config.harness_home) { $mine += [regex]::Escape([string]$config.harness_home) }

$targets = @{}
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($mine | Where-Object { $_.CommandLine -match $_ }) } |
  ForEach-Object { $targets[[int]$_.ProcessId] = "命令行匹配：$($_.ProcessName)" }

# ---- 4. 端口匹配兜底（进程名字对才动，避免误杀）----
foreach ($port in $ports) {
  try {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
      $other = [int]$_.OwningProcess
      if ($targets.ContainsKey($other)) { return }
      $proc = Get-Process -Id $other -ErrorAction SilentlyContinue
      if ($proc -and @('python', 'pythonw', 'node') -contains $proc.ProcessName) {
        $targets[$other] = "占用端口 $port：$($proc.ProcessName)"
      }
    }
  } catch { }
}

# ---- 5. 停 ----
if ($targets.Count -eq 0) {
  Say '   没有发现正在运行的实例' 'DarkGray'
} else {
  foreach ($entry in $targets.GetEnumerator()) {
    if ($DryRun) {
      Say ("   [试运行] 会停 {0}（{1}）" -f $entry.Key, $entry.Value) 'Yellow'
    } else {
      Say ("   停 {0}（{1}）" -f $entry.Key, $entry.Value) 'DarkGray'
      Stop-Process -Id $entry.Key -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($DryRun) {
  Say ''
  Say '（试运行结束，什么都没停。去掉 -DryRun 才是真的停。）' 'Yellow'
  exit 0
}

# ---- 6. 端口必须真的释放 ----
$deadline = (Get-Date).AddSeconds(15)
$busy = @()
while ((Get-Date) -lt $deadline) {
  $busy = @()
  foreach ($port in $ports) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $busy += $port }
  }
  if ($busy.Count -eq 0) { break }
  Start-Sleep -Milliseconds 400
}

Say ''
if ($busy.Count -gt 0) {
  Say ("停止失败：端口 {0} 还占着 —— 还有没认出来的实例。" -f ($busy -join '、')) 'Red'
  Say '请把下面这条的输出发给维护者：' 'Yellow'
  Say ("  Get-NetTCPConnection -LocalPort {0} -State Listen | Select-Object OwningProcess" -f $busy[0]) 'DarkGray'
  exit 1
}
Say '消息助手已停止。' 'Green'
