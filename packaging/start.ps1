<#
  启动消息助手。

  两种布局都能用（和 stop.ps1 用同一套识别逻辑）：

    * 安装版：脚本就在安装目录里，config.json 在旁边，
      用包里的 runtimes\python\pythonw.exe 跑 app\launch.py；
    * 源码检出：脚本在 packaging\ 下，根目录在上一层，
      用 .venv 或 PATH 上的 python 跑根目录的 launch.py。

  用法：
    powershell -ExecutionPolicy Bypass -File start.ps1 -Open
  双击安装目录里的 MessageAgent.cmd 就是执行这一句。
#>
param([switch]$Open, [int]$TimeoutSeconds = 75, [switch]$Quiet)

$ErrorActionPreference = 'Stop'
function Say($t, $c = 'Gray') { if (-not $Quiet) { Write-Host $t -ForegroundColor $c } }

# ---- 1. 本产品根目录（安装版 = 脚本所在目录；源码检出 = 上一层）----
function Resolve-ProductRoot([string]$start) {
  if (Test-Path -LiteralPath (Join-Path $start 'config.json')) { return $start }
  $parent = Split-Path $start -Parent
  if ($parent -and (Test-Path -LiteralPath (Join-Path $parent 'config.json'))) { return $parent }
  return $start
}

$root = Resolve-ProductRoot $PSScriptRoot
$configPath = Join-Path $root 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  Say "找不到 config.json（找过 $configPath）。先运行安装程序，或先在源码目录跑一次 prepare.py。" 'Red'
  exit 1
}
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json

$port = 3080
if ($config.harness_port) { $port = [int]$config.harness_port }
$tokenPath = $config.control_token_file
if (-not (Test-Path -LiteralPath $tokenPath)) { Say "找不到 $tokenPath，请先运行安装程序。" 'Red'; exit 1 }
$token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()

# ---- 2. 健康检查：**必须绕过系统代理** ----
# 这台机器（以及很多公司机器）走系统代理时，对 127.0.0.1 的请求会被代理转发 ——
# 症状是"服务明明起着，脚本却说启动超时"，查半天查不出来。
# 所以：先把默认代理置空再发请求，HTTP 失败时再退一步用 TCP 连端口（那一层不经过代理）。
function Test-Port {
  param([int]$Port)
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect('127.0.0.1', $Port)
    $client.Close()
    return $true
  } catch { return $false }
}

function Service-Ready {
  param([string]$Token, [int]$Port)
  $saved = [System.Net.WebRequest]::DefaultWebProxy
  try {
    [System.Net.WebRequest]::DefaultWebProxy = $null
    $response = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/message-agent/health" -f $Port) `
      -Headers @{ Authorization = "Bearer $Token" } -UseBasicParsing -TimeoutSec 3 -Proxy $null
    return ((ConvertFrom-Json $response.Content).ready -eq $true)
  } catch {
    # HTTP 这一层可能被代理/证书之类的东西干扰。端口通不等于"全好"，
    # 但用它避免"服务起来了却被判成失败"这种更糟的误报。
    return (Test-Port $Port)
  } finally {
    [System.Net.WebRequest]::DefaultWebProxy = $saved
  }
}

# ---- 3. 起 ----
if (Service-Ready $token $port) {
  Say '消息助手已经在运行。' 'Green'
  # 引擎（3080）通了不代表 worker（8767）好了：刚启动/升级的窗口期 worker 还在
  # 建库绑定，此时打开页面会看到"无法连上服务"（实测踩到）。等它绑好再开页面。
  $controlPortWait = if ($config.control_port) { [int]$config.control_port } else { 8767 }
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Port $controlPortWait) -and ((Get-Date) -lt $deadline)) {
    Start-Sleep -Milliseconds 500
  }
} else {
  Say '正在启动消息助手…' 'Cyan'

  $TaskName = 'Message Agent'
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Start-ScheduledTask -TaskName $TaskName
  } else {
    # 没有计划任务（便携安装 / 源码检出）：直接起 launcher，交给它托管整个进程树。
    $launch = Join-Path $root 'app\launch.py'
    if (-not (Test-Path -LiteralPath $launch)) { $launch = Join-Path $root 'launch.py' }

    # python 按优先级找：包里的运行时 → 仓库里的 .venv → PATH 上的 pythonw/python。
    $python = $null
    foreach ($candidate in @(
        (Join-Path $root 'runtimes\python\pythonw.exe'),
        (Join-Path $root '.venv\Scripts\pythonw.exe'),
        (Join-Path $root '.venv\Scripts\python.exe'))) {
      if (Test-Path -LiteralPath $candidate) { $python = $candidate; break }
    }
    if (-not $python) {
      foreach ($name in @('pythonw', 'python')) {
        $found = Get-Command $name -ErrorAction SilentlyContinue
        if ($found) { $python = $found.Source; break }
      }
    }
    if (-not $python) {
      Say '找不到可用的 python。源码检出请建一个 .venv（或把 python 放进 PATH）。' 'Red'
      exit 1
    }
    Say ("   用 {0} 起 {1}" -f $python, $launch) 'DarkGray'
    Start-Process -FilePath $python -ArgumentList ('"' + $launch + '"') `
      -WorkingDirectory $root -WindowStyle Hidden
  }

  # 就绪判定要看**两个**端口：3080 是引擎（harness），8767 是 worker。
  # 界面上的会话/消息走的是 worker 的接口 —— 只等 3080 会报"已启动"，
  # 用户打开页面却是一片空白（实测：worker 还没绑完端口就先报了已启动）。
  $controlPort = 8767
  if ($config.control_port) { $controlPort = [int]$config.control_port }

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 800
    if ((Service-Ready $token $port) -and (Test-Port $controlPort)) { break }
  }
  if (Service-Ready $token $port) {
    if (Test-Port $controlPort) { Say '已启动。' 'Green' }
    else { Say ("引擎起来了，但 worker 还没就绪（端口 {0}）。等一下再刷新页面；一直不行就双击 restart.ps1。" -f $controlPort) 'Yellow' }
  }
  else { Say '启动超时。日志在数据目录的 logs\harness.log：可以双击 restart.ps1 再试一次。' 'Yellow' }
}

if ($Open) {
  # 打开页面必须用引擎自己打印的登录 URL —— dsh web 的登录令牌是每次进程启动
  # 随机生成的（引擎 client-connection/browser-auth.ts），跟 worker 的 control.token
  # 是两回事。launch.py 把引擎 stdout 重定向进 harness.log，「dsh web:」那行就在里面；
  # 引擎每次启动都会打一行新的，所以取**最后一次**匹配即当前进程的 URL。
  # （以前这里错用 control.token 拼链接：老机器浏览器里有旧会话 cookie 侥幸能用，
  # 全新安装必报 "dsh web authentication required" —— 实测踩到。）
  $logPath = if ($config.log_file) { "$($config.log_file)" } else { Join-Path $root 'harness.log' }
  $webUrl = $null
  if (Test-Path -LiteralPath $logPath) {
    foreach ($line in (Get-Content -LiteralPath $logPath -Encoding UTF8)) {
      if ($line -match 'dsh web: (http://\S+)') { $webUrl = $Matches[1] }
    }
  }
  if ($webUrl) {
    Start-Process $webUrl
  } else {
    Say "没在 $logPath 里找到登录链接（「dsh web:」那一行）。手动打开该文件，把那行 URL 复制进浏览器。" 'Yellow'
  }
}
