<#
  Message Agent 安装程序。

  给谁用：**普通用户**。他不需要装 Node、Python、pnpm、.NET SDK，也不该看到任何命令行
  黑话。所以这个脚本自带所有依赖、自带中文提示、每一步都能自己重跑（幂等）。

  它做什么（对应 docs/packaging-plan.md §4.1）：
    1. 环境检查（Windows / 微信 / 端口）
    2. 展开文件到安装目录（安装目录只读也没问题）
    3. 生成运行配置（把占位符换成真实路径）
    4. 问一次模型：贴云端 key / 稍后配（key 用 Windows DPAPI 加密保存，不落明文）
    5. 迁移已有数据（检测到开发目录或旧安装就搬）
    6. 注册登录自启任务，启动并等健康检查通过，打开页面

  用法（普通用户）：右键「使用 PowerShell 运行」，或在终端执行
    powershell -ExecutionPolicy Bypass -File install.ps1
  静默安装（企业分发）：
    powershell -ExecutionPolicy Bypass -File install.ps1 -Silent -ModelKey "sk-..." -CloudKey
    powershell -ExecutionPolicy Bypass -File install.ps1 -Silent -ModelLater
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\MessageAgent'),
  [string]$DataDir    = (Join-Path $env:LOCALAPPDATA 'MessageAgent'),
  [string]$EngineRoot = '',
  [string]$RuntimeRoot = '',
  [string]$Source     = '',
  [switch]$Silent,
  [switch]$CloudKey,
  [switch]$ModelLater,
  [string]$ModelKey   = '',
  [switch]$NoStart,
  [switch]$NoTask,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
# 中文输出在两处都可能是乱码：控制台默认代码页是 GBK，而子进程（Python）按 UTF-8 输出。
# 统一按 UTF-8 解释，中文提示才不会变成"閰嶇疆"。
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
$ProgressPreference = 'SilentlyContinue'
$TaskName = 'Message Agent'
$script:StepCount = 0

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step($text) { $script:StepCount++; Say ''; Say ("[{0}] {1}" -f $script:StepCount, $text) 'Cyan' }
# 只用 ASCII 勾/叹号：✓ 在 GBK 控制台上会变成问号，用户看到"？程序文件就位"很困惑。
function Ok($text)   { Say ("    [ok] " + $text) 'Green' }
function Warn($text) { Say ("    [!]  " + $text) 'Yellow' }
function Die($text)  { Say ''; Say ("安装没有完成：" + $text) 'Red'; Say '可以修好后再运行一次这个脚本，已经做过的步骤不会重复做。' 'DarkGray'; exit 1 }

function Confirm($question, $default = $true) {
  if ($Silent) { return $default }
  $suffix = if ($default) { '[Y/n]' } else { '[y/N]' }
  $answer = Read-Host ("$question $suffix")
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer.Trim().ToLower().StartsWith('y')
}

# --------------------------------------------------------------------------
Step '检查这台电脑'

if (-not [Environment]::Is64BitOperatingSystem) { Die '需要 64 位 Windows。' }
Ok "系统：Windows $([Environment]::OSVersion.Version.Major)（64 位）"

$wechat = @("$env:USERPROFILE\xwechat_files", "$env:USERPROFILE\Documents\xwechat_files") |
  Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $wechat) {
  Warn '没有找到微信的数据目录。请先安装并登录微信（个人版），再运行本安装程序。'
  if (-not (Confirm '仍然继续安装？（装好后需要先登录微信才能读消息）' $false)) { Die '未安装微信。' }
} else {
  Ok "微信数据：$wechat"
}

foreach ($port in 8766, 8767, 3080) {
  $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($busy -and $port -ne 8766) {
    $owner = (Get-Process -Id $busy[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
    Warn "端口 $port 已被占用（$owner）。安装程序会先停掉旧的本产品进程。"
  }
}

# 消息运行时（8766）是独立产品，负责把消息真正发出去。它不在这个包里。
$runtimeAlive = Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue
if (-not $runtimeAlive) {
  Warn '没有检测到消息服务（Messaging Runtime，端口 8766）。'
  Say '    没有它：读消息、整理、待办都能用，但「发送」会失败。' 'Yellow'
  Say '    要装上它，请先运行它的安装程序，再回来运行本脚本。' 'Yellow'
}

# --------------------------------------------------------------------------
Step '准备安装位置'

if (-not $Source) {
  $Source = $PSScriptRoot
  if (Test-Path -LiteralPath (Join-Path $Source 'package')) { $Source = Join-Path $Source 'package' }
}
if (-not (Test-Path -LiteralPath (Join-Path $Source 'app\launch.py'))) {
  Die "安装源里缺少 app\launch.py。请把整个安装包目录解压后再运行（不要只复制这一个脚本）。"
}
if (-not $EngineRoot) { $EngineRoot = Join-Path $Source 'engine\harness' }
if (-not $RuntimeRoot) { $RuntimeRoot = (Get-ItemProperty 'HKCU:\Software\MessagingRuntime' -ErrorAction SilentlyContinue).Root }
if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $env:LOCALAPPDATA 'Programs\MessagingRuntime' }
if (-not (Test-Path -LiteralPath (Join-Path $EngineRoot 'apps\cli\src\bin.ts'))) {
  Die "找不到消息引擎（$EngineRoot）。它应该随安装包一起提供；如果你是开发者，可以用 -EngineRoot 指定引擎目录。"
}
if (-not (Test-Path -LiteralPath (Join-Path $RuntimeRoot '.runtime-data\shared-service.json'))) {
  Warn "没有找到消息服务的数据目录（$RuntimeRoot\.runtime-data）。如果消息服务装在别处，请用 -RuntimeRoot 指定。"
}

New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir | Out-Null
foreach ($sub in 'data', 'credentials', 'logs', 'harness', 'workspace') {
  New-Item -ItemType Directory -Force -Path (Join-Path $DataDir $sub) | Out-Null
}

# 停掉**本安装目录**正在运行的旧实例（避免文件占用和端口冲突）。
#
# ⚠️ 只允许按"本安装目录 + 本安装的配置路径"匹配命令行的进程。
# 曾经这里还写了 `-match 'agent_worker'` —— 结果装一个测试实例时把**另一个正在运行的
# 实例的 worker 一起杀了**，连带它的监护进程自毁，用户的服务直接停掉。
# 任何"按模块名匹配"的写法都会踩这个坑，永远不要加回来。
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName; Start-Sleep 3 }
$mine = @([regex]::Escape($InstallDir), [regex]::Escape((Join-Path $InstallDir 'config.json')), [regex]::Escape((Join-Path $DataDir 'config.json')))
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($mine | Where-Object { $_.CommandLine -match $_ }) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Ok "安装目录：$InstallDir"
Ok "数据目录：$DataDir"

# --------------------------------------------------------------------------
Step '展开程序文件'

$appTarget = Join-Path $InstallDir 'app'
foreach ($name in 'plugin', 'agent_worker', 'presets', 'launch.py', 'node-bootstrap.mjs', 'web.patch.yml') {
  $from = Join-Path $Source ("app\" + $name)
  if (-not (Test-Path -LiteralPath $from)) { Die "安装包里缺少 app\$name。" }
}
if (Test-Path -LiteralPath $appTarget) { Remove-Item -LiteralPath $appTarget -Recurse -Force }
Copy-Item -LiteralPath (Join-Path $Source 'app') -Destination $appTarget -Recurse -Force

# 自带运行时：普通用户机器上没有 Node 和 Python，必须连解释器一起装进来。
#
# 两个坑，都踩过：
#  1) `Copy-Item -LiteralPath <目录> -Destination <同名目录>` 会**再嵌一层**
#     （runtimes\python\python\pythonw.exe），装完报"找不到 pythonw.exe"；
#     正确做法是 -Destination 给**父目录**。
#  2) 复制完必须**验证落地文件**，否则复制失败是静默的（第一次就是静静地产出了一个空壳）。
function Copy-Component([string]$FromDir, [string]$ToParent, [string]$MustExist, [string]$Label) {
  if (-not (Test-Path -LiteralPath $FromDir)) { Die "安装包里缺少 $Label（$FromDir）。" }
  $target = Join-Path $ToParent (Split-Path $FromDir -Leaf)
  if (Test-Path -LiteralPath (Join-Path $target $MustExist)) { Ok "$Label 已存在，跳过"; return $target }
  New-Item -ItemType Directory -Force -Path $ToParent | Out-Null
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  Copy-Item -LiteralPath $FromDir -Destination $ToParent -Recurse -Force
  if (-not (Test-Path -LiteralPath (Join-Path $target $MustExist))) { Die "复制 $Label 后没有找到 $MustExist，安装中止。" }
  Ok "$Label 就位"
  return $target
}

$nodeExe = Join-Path $InstallDir 'runtimes\node\node.exe'
Copy-Component (Join-Path $Source 'runtimes\node') (Join-Path $InstallDir 'runtimes') 'node.exe' 'Node 运行时' | Out-Null
$pythonExe = Join-Path $InstallDir 'runtimes\python\pythonw.exe'
Copy-Component (Join-Path $Source 'runtimes\python') (Join-Path $InstallDir 'runtimes') 'pythonw.exe' 'Python 运行时' | Out-Null
$dblabSrc = Join-Path $InstallDir 'components\wechat-db-lab\src'
Copy-Component (Join-Path $Source 'components\wechat-db-lab\src') (Join-Path $InstallDir 'components\wechat-db-lab') 'wechat_db_lab\__init__.py' '取密钥/解密组件' | Out-Null

# 脚本与说明
foreach ($s in 'start.ps1', 'stop.ps1', 'restart.ps1', 'uninstall.ps1', 'MessageAgent.cmd', '安装说明.md', 'make_config.py', 'config.template.json', 'wechat_keys.py', '读取微信密钥.ps1') {
  $from = Join-Path $Source $s
  if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $InstallDir -Force }
}
Ok '程序文件就位'

# 引擎：随包安装到安装目录，用户不需要再装引擎依赖。
# 必须用 robocopy —— pnpm 的 node_modules 是很深的符号链接树，路径经常超过 260 字符，
# Copy-Item 会成片失败（实测）。robocopy 原生支持长路径。
if ($EngineRoot -and (Test-Path -LiteralPath (Join-Path $EngineRoot 'apps\cli\src\bin.ts'))) {
  $engineInside = [IO.Path]::GetFullPath($EngineRoot).StartsWith([IO.Path]::GetFullPath($InstallDir), 'OrdinalIgnoreCase')
  if ($engineInside) {
    Ok '引擎已在安装目录内，跳过复制'
  } else {
    Say '    正在安装消息引擎（体积大，请耐心等）…' 'DarkGray'
    $engineTarget = Join-Path $InstallDir 'engine\harness'
    New-Item -ItemType Directory -Force -Path $engineTarget | Out-Null
    & robocopy $EngineRoot $engineTarget /E /MT:16 /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { Die "安装引擎失败（robocopy 退出码 $LASTEXITCODE）。" }
    foreach ($must in 'apps\cli\src\bin.ts', 'node_modules\tsx') {
      if (-not (Test-Path -LiteralPath (Join-Path $engineTarget $must))) { Die "引擎安装后缺少 $must，安装中止。" }
    }
    $EngineRoot = $engineTarget
    Ok '消息引擎就位'
  }
} else {
  Die "安装包里没有消息引擎（$EngineRoot）。发给用户的包必须带引擎，请重新打包。"
}

# --------------------------------------------------------------------------
Step '迁移已有数据'

$devData = Join-Path (Split-Path $Source -Parent) 'data'
$migrated = 0
foreach ($db in 'reply.db', 'crm.db', 'inbox.db', 'reply-context.db', 'drafts.json', 'chat-log.json',
                'organize.json', 'conversation-sessions.json', 'reviewed.json', 'rule-order.json') {
  $from = Join-Path $devData $db
  $to = Join-Path $DataDir ("data\" + $db)
  if ((Test-Path -LiteralPath $from) -and -not (Test-Path -LiteralPath $to)) {
    # WAL 库必须用 SQLite 一致性备份，不能裸拷正在写的 .db。
    if ($db -like '*.db') {
      & $pythonExe -c "import sqlite3,sys;src=sqlite3.connect(r'$from');dst=sqlite3.connect(r'$to');src.backup(dst);dst.close();src.close()" 2>$null
      if ($LASTEXITCODE -ne 0) { Copy-Item -LiteralPath $from -Destination $to -Force }
    } else {
      Copy-Item -LiteralPath $from -Destination $to -Force
    }
    $migrated++
  }
}
foreach ($pair in @(@('control.token','data\control.token'), @('worker.token','data\worker.token'))) {
  $from = Join-Path $devData $pair[0]
  if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $DataDir $pair[1]) -Force }
}
if (Test-Path -LiteralPath (Join-Path $Source '..\.harness')) {
  foreach ($name in 'settings.yaml', '.credentials.yaml', '.anonymous-user-id') {
    $from = Join-Path $Source ("..\.harness\" + $name)
    if ((Test-Path -LiteralPath $from) -and -not (Test-Path -LiteralPath (Join-Path $DataDir ("harness\" + $name)))) {
      Copy-Item -LiteralPath $from -Destination (Join-Path $DataDir ("harness\" + $name)) -Force
    }
  }
}
if ($migrated) { Ok "迁移了 $migrated 个数据文件（原有的都没删，出问题可以退回去）" } else { Ok '没有需要迁移的旧数据' }

# --------------------------------------------------------------------------
Step '生成运行配置'

# 配置**不能**在 PowerShell 里拼字符串：Windows 路径的反斜杠在 JSON 里要写成 \\，
# 直接替换出来的是非法 JSON，装完启动会失败（实测踩到，而且是必现）。
# 所以这里只准备"替换值"，由 Python 的 json 模块负责转义 + 校验。
$values = [ordered]@{
  ENGINE_ROOT     = $EngineRoot
  RUNTIME_DATA    = (Join-Path $RuntimeRoot '.runtime-data')
  DATA_DIR        = (Join-Path $DataDir 'data')
  CREDENTIALS_DIR = (Join-Path $DataDir 'credentials')
  LOGS_DIR        = (Join-Path $DataDir 'logs')
  HARNESS_HOME    = (Join-Path $DataDir 'harness')
  WORKSPACE       = (Join-Path $DataDir 'workspace')
  NODE_EXE        = $nodeExe
  PYTHON_EXE      = $pythonExe
  DBLAB_SRC       = $dblabSrc
}
$valuesPath = Join-Path $env:TEMP ('ma-config-values-' + [Guid]::NewGuid().ToString('N') + '.json')
$values | ConvertTo-Json | Set-Content -LiteralPath $valuesPath -Encoding UTF8
$configPath = Join-Path $InstallDir 'config.json'
# 用 python.exe（控制台版）而不是 pythonw.exe：pythonw 会脱离控制台，
# 拿不到退出码也看不到错误，生成失败会变成静默失败。
$pythonConsole = Join-Path $InstallDir 'runtimes\python\python.exe'
& $pythonConsole (Join-Path $Source 'make_config.py') (Join-Path $Source 'config.template.json') $configPath $valuesPath
if ($LASTEXITCODE -ne 0) { Die '生成运行配置失败（上面的错误信息说明了原因）。' }
Remove-Item -LiteralPath $valuesPath -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $configPath -Destination (Join-Path $DataDir 'config.json') -Force
Ok "配置：$configPath"

# 产品自用的本地凭据（每次安装重新生成，不随包分发）
foreach ($token in 'control.token', 'worker.token') {
  $path = Join-Path $DataDir ("data\" + $token)
  if (-not (Test-Path -LiteralPath $path)) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [IO.File]::WriteAllText($path, [Convert]::ToBase64String($bytes))
  }
}

# --------------------------------------------------------------------------
Step '配置大模型'

$credDir = Join-Path $DataDir 'credentials'
$modelStore = Join-Path $credDir 'model-cloud.dat'
$haveKey = Test-Path -LiteralPath $modelStore

if (-not $haveKey -and -not $ModelLater) {
  Say '    这个产品需要一个大模型来写回复、整理消息。两种用法：' 'White'
  Say '      1) 云端模型：需要一串 API key（推荐，开箱即用）' 'White'
  Say '      2) 本地模型：不联网，但要自己装 Ollama 并下载模型' 'White'
  Say '    现在不配也可以，稍后在页面「设置 → 模型」里补。' 'DarkGray'
  $choice = if ($Silent) { if ($CloudKey) { '1' } else { '3' } } else { Read-Host '    请选择 [1/2/3，直接回车=3 稍后配]' }
  if ($choice -eq '1' -and -not $ModelKey) {
    $sec = Read-Host '    请粘贴 API key（输入时不会显示）' -AsSecureString
    $ModelKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  }
  if ($choice -eq '1' -and $ModelKey) {
    $haveKey = $true
  } elseif ($choice -eq '2') {
    Say '    好。装好后在页面「设置 → 模型」里：先装 Ollama，再回来点刷新选模型。' 'DarkGray'
    $ModelLater = $true
  } else {
    Warn '先不配密钥。自动回复和整理消息在配好之前会报错，页面上有提示。'
    $ModelLater = $true
  }
}

if ($ModelKey) {
  # 交给 Python 写：DPAPI 加解密只有一处实现，避免 PowerShell 和 Python 各写一份。
  $env:MA_KEY_INPUT = $ModelKey
  & $pythonExe -c @"
import json, os, sys
sys.path.insert(0, r'$appTarget')
from agent_worker import secrets_store
secrets_store.write_secret(r'$modelStore', {'DEEPSEEK_API_KEY': os.environ['MA_KEY_INPUT'], 'saved_by': 'installer'})
"@
  if ($LASTEXITCODE -ne 0) { Die '保存 API key 失败（密钥保管组件不可用）。' }
  $env:MA_KEY_INPUT = $null
  Ok 'API key 已用 Windows 密钥保护写入（磁盘上没有明文）'
}

# --------------------------------------------------------------------------
Step '保管微信数据库密钥'

# 密钥原来以明文 JSON 存在 %LOCALAPPDATA%\wechat-db-lab\keys 下（还可能有个 .bak）。
# 这里把它们收进 Windows 密钥保护（DPAPI）并删掉明文；日常启动只解密到运行时目录，
# 磁盘上不再有长期存在的明文密钥。
$credDir = Join-Path $DataDir 'credentials'
$keyStore = Join-Path $credDir 'wechat-keys.dat'
$env:MESSAGE_AGENT_CREDENTIALS = $credDir
$keysScript = Join-Path $InstallDir 'wechat_keys.py'
$migrateOutput = & $pythonConsole $keysScript 'migrate' 2>&1
$migrateOutput | ForEach-Object { Say ("    " + $_) 'DarkGray' }
$hasKeys = Test-Path -LiteralPath $keyStore

if ($hasKeys) {
  Ok '密钥已加密保存，明文缓存已清理'
} else {
  Say '' 
  Warn '还没有可用的密钥 —— 现在读一次，还是稍后自己读？'
  Say '    读密钥需要**读一次微信进程内存**（唯一需要你授权的动作），所以不自动做。' 'Yellow'
  Say '    前提：微信正在运行并已登录。' 'Yellow'
  $doScan = if ($Silent) { $false } else { Confirm '    现在读取微信密钥吗？（推荐：现在读，装完马上就能用）' $true }
  if ($doScan) {
    Say '    正在读取（这一步会读一次微信进程内存）…' 'DarkGray'
    $scanOutput = & $pythonConsole $keysScript 'scan' 2>&1
    $scanOutput | ForEach-Object { Say ("    " + $_) 'DarkGray' }
    if (Test-Path -LiteralPath $keyStore) { Ok '密钥已加密保存' }
    else { Warn '没有读到密钥。装好后可以右键运行安装目录里的「读取微信密钥.ps1」再试。' }
  } else {
    Warn '先跳过。装好后右键运行安装目录里的「读取微信密钥.ps1」即可（也只有那一次会读内存）。'
  }
}

# --------------------------------------------------------------------------
Step '设置开机启动'

if ($NoTask) {
  # 便携/测试安装：不注册计划任务，用 start.ps1 手动起。
  Ok '按参数要求跳过开机自启（用 start.ps1 手动启动）'
} else {
$action = New-ScheduledTaskAction -Execute (Join-Path $InstallDir 'runtimes\python\pythonw.exe') `
  -Argument ('"' + (Join-Path $InstallDir 'app\launch.py') + '"') -WorkingDirectory $InstallDir
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Trigger $trigger `
  -Settings $settings -Description 'Message Agent：读本地微信数据库，自动回复与整理消息。' -Force | Out-Null
Ok "已注册开机自启（任务名：$TaskName）"
}

# 桌面快捷方式：普通用户不该被要求记住任何命令
if (-not $Silent) {
  try {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) '消息助手.lnk'))
    $lnk.TargetPath = Join-Path $InstallDir 'MessageAgent.cmd'
    $lnk.WorkingDirectory = $InstallDir
    $lnk.IconLocation = (Join-Path $InstallDir 'runtimes\python\pythonw.exe') + ',0'
    $lnk.Save()
    Ok '桌面已创建「消息助手」快捷方式'
  } catch { Warn '创建快捷方式失败（不影响使用，可以自己双击安装目录里的 MessageAgent.cmd）' }
}

# --------------------------------------------------------------------------
Step '启动并检查'

if ($NoStart) { Ok '按参数要求跳过启动' }
else {
  Start-ScheduledTask -TaskName $TaskName
  Say '    正在启动（第一次启动会慢一些，最多等 60 秒）…' 'DarkGray'
  $token = Get-Content -LiteralPath (Join-Path $DataDir 'data\control.token') -Raw
  $deadline = (Get-Date).AddSeconds(75)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 800
    try {
      $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/message-agent/health' `
        -Headers @{ Authorization = "Bearer $($token.Trim())" } -UseBasicParsing -TimeoutSec 3
      if ((ConvertFrom-Json $response.Content).ready -eq $true) { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) {
    Warn '服务没有在 60 秒内就绪。'
    Say '    请把这两个文件发给开发者：' 'Yellow'
    Say ("      " + (Join-Path $DataDir 'logs\harness.log')) 'Yellow'
    Say ("      " + (Join-Path $DataDir 'logs\harness.log.1')) 'Yellow'
    Say '    也可以自己双击「MessageAgent.cmd」再试一次。' 'Yellow'
  } else {
    Ok '服务已就绪'
    $url = "http://127.0.0.1:3080/?token=$($token.Trim())"
    Say ''
    Say '安装完成。' 'Green'
    Say '  以后使用：双击桌面的「消息助手」。' 'White'
    Say '  停止/重启：安装目录里的 stop.ps1 / restart.ps1。' 'White'
    if ($ModelLater) { Say '  别忘了在「设置 → 模型」里配好大模型。' 'Yellow' }
    if (-not $Silent) { Start-Process $url }
  }
}
