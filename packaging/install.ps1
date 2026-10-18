<#
  Message Agent 安装程序。

  给谁用：**普通用户**。他不需要装 Node、Python、pnpm、.NET SDK，也不该看到任何命令行
  黑话。所以这个脚本自带所有依赖、自带中文提示、每一步都能自己重跑（幂等）。

  它做什么：
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

# 清空一个目录。**不能用 Remove-Item**：它和 Copy-Item 一样受 260 字符路径限制，
# 引擎的 node_modules 里随手就是超长路径；拿空目录 robocopy /MIR 过去最稳。
function Clear-Dir($path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $empty = Join-Path $env:TEMP ('ma-empty-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $empty | Out-Null
  & robocopy $empty $path /MIR /NFL /NDL /NJH /NJS /R:0 /W:0 | Out-Null
  Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $path) { Die "清空目录失败：$path" }
}

function Confirm($question, $default = $true) {  if ($Silent) { return $default }
  $suffix = if ($default) { '[Y/n]' } else { '[y/N]' }
  $answer = Read-Host ("$question $suffix")
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer.Trim().ToLower().StartsWith('y')
}

# --------------------------------------------------------------------------
Step '检查这台电脑'

if (-not [Environment]::Is64BitOperatingSystem) { Die '需要 64 位 Windows。' }
# 注意：Win11 的 Version.Major **仍然是 10**（内部版本号 ≥ 22000 才是 Win11）。
# 只打印 Major 会把 Win11 说成 Win10，客户会怀疑装错版本（实测被问到）。
$osBuild = [Environment]::OSVersion.Version.Build
$osName =
  if ($osBuild -ge 22000) { 'Windows 11' }
  elseif ($osBuild -ge 10240) { 'Windows 10' }
  else { "Windows $([Environment]::OSVersion.Version.Major)" }
Ok "系统：$osName（版本 $osBuild，64 位）"

$wechat = @("$env:USERPROFILE\xwechat_files", "$env:USERPROFILE\Documents\xwechat_files")
# 客户改过"文件保存位置"的话，默认位置是空的 —— 这里也认微信自己记的那个路径
# （4.x 记在 HKCU\Software\Tencent\Weixin 的 OldFileSavePath，3.x 在 ...\WeChat 的 FileSavePath）。
foreach ($key in @('HKCU:\Software\Tencent\Weixin', 'HKCU:\Software\Tencent\WeChat')) {
  $props = Get-ItemProperty $key -ErrorAction SilentlyContinue
  if (-not $props) { continue }
  foreach ($name in @('OldFileSavePath', 'FileSavePath')) {
    $value = "$($props.$name)"
    if ($value -match '^[A-Za-z]:\\' -and (Test-Path -LiteralPath $value)) {
      $wechat += $value
      foreach ($sub in @('xwechat_files', 'WeChat Files')) { $wechat += (Join-Path $value $sub) }
    }
  }
}
$wechat = @($wechat) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $wechat) {
  # 只提醒、**不拦**：安装本身不依赖微信数据（数据是"解锁"那一步产出的）。
  # 以前这里是 Confirm … $false（默认 No），客户随手一回车就把安装取消了 —— 实测踩到。
  Warn '暂时没看到微信的数据目录。装完后登录微信，再双击一次 开始使用.cmd 来读消息即可。'
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
# 引擎有两种随包形式：目录（开发/自用）或单个归档（正式分发，见 build-package.ps1）。
if (-not (Test-Path -LiteralPath (Join-Path $EngineRoot 'apps\cli\src\bin.ts')) -and
    -not (Test-Path -LiteralPath (Join-Path $Source 'engine\harness.tar'))) {
  Die "找不到消息引擎（既没有 $EngineRoot，也没有 engine\harness.tar）。发给用户的包必须带引擎；开发者可以用 -EngineRoot 指定引擎目录。"
}

# 消息运行时：**包里带了就直接装** —— 客户只需要拿到这一个包。
# 它是启动硬前提（app\launch.py 要读它的 .runtime-data\shared-service.json 拿 token，
# 发送也全靠它），以前要单独装，客户装完这个包照样起不来。
$bundledRuntime = Join-Path $Source 'components\messaging-runtime'
if (Test-Path -LiteralPath (Join-Path $bundledRuntime 'artifacts\app\messaging-runtime.dll')) {
  Step '安装消息运行时'
  # 只覆盖**程序文件**（artifacts/tools/config/runtime），**绝不动 .runtime-data**
  # —— 那里是客户的消息库与审批记录，覆盖掉就是数据事故。
  New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
  foreach ($name in 'artifacts','tools','config','runtime') {
    $from = Join-Path $bundledRuntime $name
    if (-not (Test-Path -LiteralPath $from)) { continue }
    # robocopy：node_modules/python 那种深度路径用 Copy-Item 会成片失败（260 字符限制）。
    & robocopy $from (Join-Path $RuntimeRoot $name) /E /NFL /NDL /NJH /NJS /R:1 /W:1 /XD __pycache__ | Out-Null
    if ($LASTEXITCODE -ge 8) { Die "复制消息运行时失败（robocopy 退出码 $LASTEXITCODE）：$name" }
  }
  Say ("    已装到 $RuntimeRoot") 'Gray'
  # 让 message-agent 与其它工具都能找到它（install.ps1 自己也读这个键）。
  New-Item -Path 'HKCU:\Software\MessagingRuntime' -Force | Out-Null
  Set-ItemProperty -Path 'HKCU:\Software\MessagingRuntime' -Name 'Root' -Value $RuntimeRoot
  if (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'artifacts\app\coreclr.dll')) {
    Say '    自带 .NET 运行时（客户机不需要另装 .NET）' 'Gray'
  } else {
    Warn '    这份运行时是"依赖框架"的，客户机需要装 .NET 8 才能发消息。'
    Warn '    要出免装 .NET 的包，重新构建时加：tools\package.ps1 -SelfContained'
  }
} elseif (-not (Test-Path -LiteralPath (Join-Path $RuntimeRoot '.runtime-data\shared-service.json'))) {
  Warn "没有找到消息服务（$RuntimeRoot\.runtime-data），包里也没带。"
  Warn '装好后程序能启动但发不出消息；补齐办法：用 -RuntimeRoot 指定，或让消息服务单独装好。'
}

New-Item -ItemType Directory -Force -Path $InstallDir, $DataDir | Out-Null

# 是全新安装还是升级？升级时**程序文件更新、你的东西全保留**，所以先把这件事说清楚，
# 免得用户以为又要从头配一遍。上一次装了什么版本记在 .install-info.json 里。
$infoPath = Join-Path $InstallDir '.install-info.json'
$previous = [ordered]@{}
if (Test-Path -LiteralPath $infoPath) {
  try { $previous = Get-Content -LiteralPath $infoPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $previous = [ordered]@{} }
} elseif (Test-Path -LiteralPath (Join-Path $InstallDir 'config.json')) {
  # 老版本没写过这个文件，但装过就一定有 config.json
  $previous = [ordered]@{ version = '（更早的版本）' }
}
# 包里的 manifest.json 带着引擎归档的 sha256 —— 用它判断"引擎变没变"，
# 不用自己重算（1.5GB 算一次要 8 分钟）。
$packagedEngineHash = ''
$manifest = [ordered]@{}
$manifestPath = Join-Path $Source 'manifest.json'
if (Test-Path -LiteralPath $manifestPath) {
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $entry = $manifest.files | Where-Object { $_.path -eq 'engine/harness.tar' } | Select-Object -First 1
    if ($entry) { $packagedEngineHash = $entry.sha256 }
  } catch { }
}
if ($previous.version) {
  Say ''
  Say ("检测到这台电脑已经装过这个产品（上次：{0}）。" -f $previous.version) 'Cyan'
  Say '  按**升级**处理：程序文件更新到新版，你的聊天数据、待办、密钥、模型配置全部保留。' 'White'
  Say ("  你的数据在：{0}" -f $DataDir) 'DarkGray'
}
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
function Copy-Component([string]$FromDir, [string]$ToParent, [string]$MustExist, [string]$Label,
                        [switch]$Refresh) {
  if (-not (Test-Path -LiteralPath $FromDir)) { Die "安装包里缺少 $Label（$FromDir）。" }
  $target = Join-Path $ToParent (Split-Path $FromDir -Leaf)
  if (-not $Refresh) {
    if (Test-Path -LiteralPath (Join-Path $target $MustExist)) { Ok "$Label 已存在，跳过"; return $target }
  }
  New-Item -ItemType Directory -Force -Path $ToParent | Out-Null
  if (Test-Path -LiteralPath $target) { Clear-Dir $target }
  Copy-Item -LiteralPath $FromDir -Destination $ToParent -Recurse -Force
  if (-not (Test-Path -LiteralPath (Join-Path $target $MustExist))) { Die "复制 $Label 后没有找到 $MustExist，安装中止。" }
  Ok $(if ($Refresh) { "$Label 已更新到新版" } else { "$Label 就位" })
  return $target
}

$nodeExe = Join-Path $InstallDir 'runtimes\node\node.exe'
# 运行时平时不变，所以"已存在就跳过"。但万一新版换了 Node/Python 版本，
# 跳过就会让新程序跑在旧解释器上 —— 拿包里的版本号和装着的实际版本比一下，不一致就更新。
$refreshNode = $false
if (Test-Path -LiteralPath $nodeExe) {
  $installedNode = (& $nodeExe '-v') 2>$null
  $packagedNode = $manifest.components.node.version
  $refreshNode = [bool]($packagedNode -and $installedNode -and ($installedNode.Trim() -ne $packagedNode.Trim()))
  if ($refreshNode) { Warn "Node 版本要更新：$installedNode -> $packagedNode" }
}
Copy-Component (Join-Path $Source 'runtimes\node') (Join-Path $InstallDir 'runtimes') 'node.exe' 'Node 运行时' -Refresh:$refreshNode | Out-Null
$pythonExe = Join-Path $InstallDir 'runtimes\python\pythonw.exe'
$refreshPython = $false
if (Test-Path -LiteralPath $pythonExe) {
  $installedPython = (& (Join-Path $InstallDir 'runtimes\python\python.exe') '-c' 'import sys;print(sys.version.split()[0])') 2>$null
  $packagedPython = $manifest.components.python.version
  $refreshPython = [bool]($packagedPython -and $installedPython -and ($installedPython.Trim() -ne $packagedPython.Trim()))
  if ($refreshPython) { Warn "Python 版本要更新：$installedPython -> $packagedPython" }
}
Copy-Component (Join-Path $Source 'runtimes\python') (Join-Path $InstallDir 'runtimes') 'pythonw.exe' 'Python 运行时' -Refresh:$refreshPython | Out-Null
# 注：**不再安装取密钥/解密组件**。本项目不接触密钥与解密 —— 解锁由外部完成，
# 本项目只读一个"已解锁目录"（协议见仓库里的 docs/unlocked-db-protocol.md）。
# 语音解码器：75 KB 的预编译可执行文件，随包走、零安装。没有它就只能"读不到语音内容"。
Copy-Component (Join-Path $Source 'components\silk') (Join-Path $InstallDir 'components') 'silk-decoder-x64.exe' '语音解码组件' | Out-Null

# 脚本与说明：**按类型整体复制，不列白名单**。
# 清单一定会漂，索性不列。
foreach ($file in (Get-ChildItem -LiteralPath $Source -File |
    Where-Object { $_.Extension -in '.ps1', '.py', '.cmd', '.md', '.json' -and $_.Name -ne 'manifest.json' })) {
  Copy-Item -LiteralPath $file.FullName -Destination $InstallDir -Force
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
    $engineTarget = Join-Path $InstallDir 'engine\harness'
    Say '    正在安装消息引擎（体积大，请耐心等）…' 'DarkGray'
    New-Item -ItemType Directory -Force -Path $engineTarget | Out-Null
    & robocopy $EngineRoot $engineTarget /E /MT:16 /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { Die "安装引擎失败（robocopy 退出码 $LASTEXITCODE）。" }
    foreach ($must in 'apps\cli\src\bin.ts', 'node_modules\tsx') {
      if (-not (Test-Path -LiteralPath (Join-Path $engineTarget $must))) { Die "引擎安装后缺少 $must，安装中止。" }
    }
    $EngineRoot = $engineTarget
    Ok '消息引擎就位'
  }
} elseif (Test-Path -LiteralPath (Join-Path $Source 'engine\harness.tar')) {
  # 引擎以单个归档形式随包提供：一次解包，比逐文件复制快得多（Windows 10 起自带 tar）。
  $engineTarget = Join-Path $InstallDir 'engine\harness'
  #
  # 升级的关键：**先清空再解包**，否则上一版删掉的文件会留在原地（新引擎少了一个包，
  # 旧包里那个还在 → 解析到不该存在的模块）。同一版本重装则跳过，省掉一次 1.5GB 的搬运：
  # 包的 manifest.json 里就有引擎归档的 sha256，不用自己重算（算一次要 8 分钟）。
  $engineUnchanged = $false
  if ($packagedEngineHash -and $previous.engineSha -and ($previous.engineSha -eq $packagedEngineHash) -and
      (Test-Path -LiteralPath (Join-Path $engineTarget 'apps\cli\src\bin.ts'))) {
    $engineUnchanged = $true
  }
  if ($engineUnchanged) {
    Ok '消息引擎与已装版本相同，跳过'
  } else {
    if (Test-Path -LiteralPath $engineTarget) {
      Say '    清掉上一版引擎（避免旧文件残留）…' 'DarkGray'
      Clear-Dir $engineTarget
    }
    New-Item -ItemType Directory -Force -Path $engineTarget | Out-Null
    Say '    正在解开消息引擎（体积大，请耐心等）…' 'DarkGray'
    # 引擎里有 18,697 个 pnpm 链接（多半是**目录**链接）+ 300 字符的深路径：
    #   * 系统 tar.exe 死在长路径（\\?\ 上 Invalid argument）
    #   * Python tarfile 直接 extractall 死在"链接目录下的文件"（FileNotFoundError）
    #   * NTFS 不允许目录硬链接 —— 目录必须建 junction
    # 所以交给 extract_engine.py：先解普通文件，再按类型补链接（目录→junction，
    # 文件→硬链接/复制）。junction 不需要管理员权限，也不占额外空间。
    $enginePython = Join-Path $Source 'runtimes\python\python.exe'
    if (-not (Test-Path -LiteralPath $enginePython)) { Die "包里缺少 Python 运行时，无法解开引擎：$enginePython" }
    $extractor = Join-Path $Source 'extract_engine.py'
    if (-not (Test-Path -LiteralPath $extractor)) { Die "包里缺少 extract_engine.py，无法解开引擎：" }
    & $enginePython $extractor (Join-Path $Source 'engine\harness.tar') $engineTarget
    if ($LASTEXITCODE -ne 0) { Die "解包引擎失败（extract_engine.py 退出码 $LASTEXITCODE，具体见上面的清单）。" }
    foreach ($must in 'apps\cli\src\bin.ts', 'node_modules\tsx') {
      if (-not (Test-Path -LiteralPath (Join-Path $engineTarget $must))) { Die "引擎解包后缺少 $must，安装中止。" }
    }
    $EngineRoot = $engineTarget
    Ok '消息引擎就位'
  }
} else {
  Die "安装包里没有消息引擎（也没找到 engine\harness.tar）。发给用户的包必须带引擎，请重新打包。"
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
Step '已解锁数据库（需要你自己准备）'

# 本项目**不接触密钥与解密**：不读进程内存、不取密钥、不做页解密、不合并 WAL。
# 它只读一个"已解锁目录" —— 由你自己选择工具完成解锁，产出物要符合
# docs/unlocked-db-protocol.md（一个 manifest.json + plain/ 下的明文库）。
Say '    安装完成后，请把 config.json 里的 unlocked_root 指向你的已解锁目录。' 'Yellow'
Say '    产物协议见安装目录里的 docs/unlocked-db-protocol.md。' 'DarkGray'
Say '    没有产物时程序能启动，但读不到消息；界面会提示缺什么。' 'DarkGray'

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
    Say $(if ($previous.version) { '升级完成。' } else { '安装完成。' }) 'Green'
    Say '  以后使用：双击桌面的「消息助手」。' 'White'
    Say '  停止/重启：安装目录里的 stop.ps1 / restart.ps1。' 'White'
    if ($previous.version) {
      Say ("  你的数据、密钥、模型配置都在：{0}" -f $DataDir) 'White'
      Say ("  要回到旧版：把旧版安装包解压后再运行一次它的 install.ps1（数据同样保留）。") 'DarkGray'
    }
    if ($ModelLater) { Say '  别忘了在「设置 → 模型」里配好大模型。' 'Yellow' }
    if (-not $Silent) { Start-Process $url }
  }
}

# 记下"这次装的是哪一版"，下一次运行就能判断是升级、以及引擎要不要重装。
# 装失败（Die）时不会走到这里 —— 半成品不该被记成"已安装这个版本"。
$info = [ordered]@{
  version    = $(if ($manifest.version) { $manifest.version } else { 'dev' })
  engineSha  = $packagedEngineHash
  node       = $(if ($manifest.components.node.version) { $manifest.components.node.version } else { '' })
  python     = $(if ($manifest.components.python.version) { $manifest.components.python.version } else { '' })
  installedAt = (Get-Date).ToString('s')
}
$info | ConvertTo-Json | Set-Content -LiteralPath $infoPath -Encoding UTF8
