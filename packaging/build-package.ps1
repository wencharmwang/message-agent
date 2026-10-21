<#
  组装可交付的安装包目录（给普通用户的那种）。

  产出：<OutDir>\package\
    app\                 产品本体（plugin/ agent_worker/ presets/ launch.py …）
    runtimes\node\       自带 Node（用户不需要自己装）
    runtimes\python\     自带 Python（用户不需要自己装）
    engine\harness\      消息引擎（默认整包带走；-SkipEngine 可跳过）
    install.ps1 等脚本 + config.template.json + README-install.md
    manifest.json        版本与文件哈希清单

  用法：
    powershell -ExecutionPolicy Bypass -File build-package.ps1 -MakeZip
    （-MakeZip 额外产出一个可直接交付的单文件：out\MessageAgent-<版本>-win64.zip）
    powershell -ExecutionPolicy Bypass -File build-package.ps1 -EngineRoot C:\...\deepseek-harness
    powershell -ExecutionPolicy Bypass -File build-package.ps1 -NodeRuntime <node目录> -PythonRuntime <python目录>

  关于引擎：**默认整包带走**（用户不该再自己装引擎依赖）。当前引擎是"TS 源码 + pnpm
  node_modules"，靠 tsx 直接跑 —— 能跑，但体积大（GB 级）。用 robocopy 复制，因为 pnpm 的
  符号链接树路径普遍超过 260 字符，Copy-Item 会成片失败。
  以后若引擎提供官方构建产物（`tsx scripts/build.ts`），换成那份会更小更快。
#>
[CmdletBinding()]
param(
  # 注意：这些默认值**不能**写成 Join-Path $PSScriptRoot ... ——
  # Windows PowerShell 5.1 在解析 param 默认值时 $PSScriptRoot 还是空的（实测报错
  # "参数为空字符串"）。所以统一留空，进函数体再解析。
  [string]$OutDir = '',
  [string]$RepoRoot = '',
  [string]$EngineRoot = '',
  [string]$RuntimePackage = '',
  [string]$NodeRuntime = '',
  [string]$PythonRuntime = '',
  [string]$NodeVersion = 'v22.23.0',
  [string]$PythonVersion = '3.13.12',
  # 交付版本号。修了产品代码就升一个 patch 号 —— 客户支持时不至于
  # "两个包都叫 0.1.0，分不清哪个带修复"。引擎/运行时没变时老客户只下 -AppOnly 小包。
  # （下面代码里的 $version 就是这个变量，PowerShell 变量名不区分大小写。）
  [string]$Version = '0.1.1',
  [switch]$SkipEngine,
  [switch]$SkipRuntime,
  [switch]$SkipHashes,
  [switch]$ForceEngine,
  # 升级小包：只装产品本体（app\ + 脚本 + 语音解码组件，约几 MB），不带引擎、
  # 运行时和消息运行时 —— install.ps1 会校验已装版本并沿用。客户日常发版下载它
  # 就够，不用再拉 483MB 完整包。要求先跑过一次完整打包（.cache\last-full-build.json
  # 记着引擎哈希与运行时版本）。
  [switch]$AppOnly,
  # 注意：**不能**把这个开关叫 -Zip —— PowerShell 的变量名不区分大小写，
  # 它会和下面下载 node/python 用的 $zip（压缩包路径）变成同一个变量，
  # 于是"把字符串赋给 switch 参数"直接抛类型转换错（实测踩到）。
  [switch]$MakeZip,
  [string]$LogTo = ''
)

# 构建很久（引擎归档约 10 分钟、哈希 8 分钟），常常放在计划任务里跑。
# 用 transcript 把完整输出落到文件，比在外面套重定向稳（不涉及嵌套引号）。
if ($LogTo) {
  try { Start-Transcript -LiteralPath $LogTo -Force | Out-Null } catch { Write-Host "无法写日志到 $LogTo：$($_.Exception.Message)" -ForegroundColor Yellow }
}

if (-not $OutDir)     { $OutDir = Join-Path $PSScriptRoot 'out' }
if (-not $RepoRoot)   { $RepoRoot = Split-Path $PSScriptRoot -Parent }
if (-not $EngineRoot) {
  # 优先用构建产物（build-engine-deploy.ps1 的输出）：小、快、无符号链接；
  # 没有就退回源码仓（打 tar 的旧流程）。
  $harnessGuess = Join-Path (Split-Path $RepoRoot -Parent) 'deepseek-harness'
  $deployGuess = Join-Path $harnessGuess 'artifacts\web-deploy'
  if (Test-Path -LiteralPath (Join-Path $deployGuess 'lib\bin.js')) { $EngineRoot = $deployGuess }
  else { $EngineRoot = $harnessGuess }
}

$ErrorActionPreference = 'Stop'
# 下载/解压的进度条会把输出刷成几万行，日志完全没法看（实测）。关掉。
$ProgressPreference = 'SilentlyContinue'
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Step($t) { Say ''; Say "== $t" 'Cyan' }

$package = Join-Path $OutDir 'package'
# 引擎归档 1.5GB、重打要 10 分钟。缓存放**固定位置**：
# 以前放在 -OutDir 里 —— 一换输出目录缓存就失效，于是每次重打（实测踩到，
# 为了避开"清理旧包"的问题每次都用新 -OutDir，结果每次都白等 10 分钟）。
# 现在换目录也能复用；只有引擎代码变了才需要 -ForceEngine。
$cacheDir = Join-Path $RepoRoot 'packaging\.cache'
$tarCache = Join-Path $cacheDir 'harness.tar'
$existingTar = Join-Path $package 'engine\harness.tar'
if (-not $ForceEngine -and -not $SkipEngine -and -not $AppOnly) {
  # ① 优先用固定缓存
  if (Test-Path -LiteralPath $tarCache) {
    Say ''; Say '复用缓存里的引擎归档（要重打加 -ForceEngine）' 'DarkGray'
  } elseif ((Test-Path -LiteralPath $existingTar) -and ((Get-Item -LiteralPath $existingTar).Length -gt 100MB)) {
    # ② 退一步：旧包里的那份（同一 -OutDir 重跑时）
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    Copy-Item -LiteralPath $existingTar -Destination $tarCache -Force
    Say ''; Say '把旧包里的引擎归档收进缓存（下次换目录也能复用）' 'DarkGray'
  }
}
if (Test-Path -LiteralPath $package) {
  # 清理旧包**不能用 Remove-Item**：它和 Copy-Item 一样受 260 字符路径限制，
  # 而引擎的 node_modules 里随手就是超长路径（实测报"对路径 someLimit.js 的访问被拒绝"，
  # 进而把整次构建卡死在清理这一步）。用 robocopy 拿空目录镜像过去最稳。
  $empty = Join-Path $env:TEMP ('ma-empty-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $empty | Out-Null
  & robocopy $empty $package /MIR /NFL /NDL /NJH /NJS /R:0 /W:0 | Out-Null
  Remove-Item -LiteralPath $package -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $package) { throw "清理旧包失败（$package 还在）。手动删掉它再重试。" }
}
New-Item -ItemType Directory -Force -Path $package | Out-Null
if (-not $AppOnly -and (Test-Path -LiteralPath $tarCache)) {
  New-Item -ItemType Directory -Force -Path (Join-Path $package 'engine') | Out-Null
  # 用**复制**而不是移动：缓存要留着，下次换输出目录还能复用。
  Copy-Item -LiteralPath $tarCache -Destination (Join-Path $package 'engine\harness.tar') -Force
}

# -- 1. 产品本体 ------------------------------------------------------------
Step '复制产品本体'
$appOut = Join-Path $package 'app'
New-Item -ItemType Directory -Force -Path $appOut | Out-Null
foreach ($name in 'plugin', 'agent_worker', 'presets') {
  Copy-Item -LiteralPath (Join-Path $RepoRoot $name) -Destination $appOut -Recurse -Force
}
foreach ($file in 'launch.py', 'node-bootstrap.mjs', 'web.patch.yml') {
  Copy-Item -LiteralPath (Join-Path $RepoRoot $file) -Destination $appOut -Force
}
# 源码包里的缓存/测试产物不进发行物。
# 注意：**不要**用 `Get-ChildItem -File -Include '*.pyc'` —— 实测在 PowerShell 5.1 里
# 这个组合会把目录也返回，后面 Remove-Item 会删错东西（`app` 被清空就是这么来的）。
# 一律显式列出、按名字判断。
# 用 foreach 逐个删，**不要**用管道接删除命令：某些环境会把删除命令换成不接受管道输入的
# 安全包装，管道写法在那里会直接报"无法将输入对象绑定到命令的任何参数"，而且是**静默中止**
# （日志里什么都没有）—— 实测排查了很久。模块限定名可以绕开那层包装。
foreach ($dir in @(Get-ChildItem -LiteralPath $appOut -Recurse -Force -Directory |
                   Where-Object { $_.Name -eq '__pycache__' })) {
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
foreach ($file in @(Get-ChildItem -LiteralPath $appOut -Recurse -Force -File |
                    Where-Object { $_.Extension -eq '.pyc' -or $_.Name -like '*.test.mjs' })) {
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
}
$appFiles = (Get-ChildItem -LiteralPath $appOut -Recurse -Force -File).Count
if ($appFiles -lt 10) { throw "产品本体复制后只有 $appFiles 个文件，明显不对，中止打包以免发出空包。" }
Say ("    app\ -> {0:N0} KB，{1} 个文件" -f ((Get-ChildItem $appOut -Recurse -File | Measure-Object Length -Sum).Sum / 1KB), $appFiles) 'Green'

# -- 2. 运行时（自带，用户不用装） -------------------------------------------
Step '准备自带运行时'
if ($AppOnly) {
  Say '    升级小包不带运行时（install.ps1 会校验并沿用客户机已装版本）' 'DarkGray'
} else {
$nodeOut = Join-Path $package 'runtimes\node'
$pythonOut = Join-Path $package 'runtimes\python'
New-Item -ItemType Directory -Force -Path $nodeOut, $pythonOut | Out-Null

if ($NodeRuntime) {
  Copy-Item -Path (Join-Path $NodeRuntime '*') -Destination $nodeOut -Recurse -Force
  Say "    node 来自本地：$NodeRuntime" 'Green'
} else {
  $nodeZip = Join-Path $env:TEMP "node-$NodeVersion-win-x64.zip"
  if (-not (Test-Path -LiteralPath $nodeZip)) {
    Say "    下载官方 Node $NodeVersion …" 'DarkGray'
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip" -OutFile $nodeZip -UseBasicParsing
  }
  Expand-Archive -LiteralPath $nodeZip -DestinationPath (Join-Path $env:TEMP 'ma-node-extract') -Force
  Copy-Item -Path (Join-Path $env:TEMP "ma-node-extract\node-$NodeVersion-win-x64\*") -Destination $nodeOut -Recurse -Force
  Say '    node 来自官方发行包' 'Green'
}
if (-not (Test-Path -LiteralPath (Join-Path $nodeOut 'node.exe'))) { throw "node 运行时里没有 node.exe（$nodeOut）" }
Say ("    node: " + (& (Join-Path $nodeOut 'node.exe') '-v')) 'Green'

if ($PythonRuntime) {
  Copy-Item -Path (Join-Path $PythonRuntime '*') -Destination $pythonOut -Recurse -Force
  Say "    python 来自本地：$PythonRuntime" 'Green'
} else {
  $pythonZip = Join-Path $env:TEMP "python-$PythonVersion-embed-amd64.zip"
  if (-not (Test-Path -LiteralPath $pythonZip)) {
    Say "    下载官方 Python $PythonVersion（embeddable）…" 'DarkGray'
    Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" -OutFile $pythonZip -UseBasicParsing
  }
  Expand-Archive -LiteralPath $pythonZip -DestinationPath $pythonOut -Force
  Say '    python 来自官方 embeddable 包' 'Green'
}
if (-not (Test-Path -LiteralPath (Join-Path $pythonOut 'pythonw.exe'))) { throw "python 运行时里没有 pythonw.exe（$pythonOut）" }

# embeddable 包默认用 ._pth 隔离 sys.path：允许 import 工作目录，worker 才能 import agent_worker
$pth = Get-ChildItem -LiteralPath $pythonOut -Filter 'python*._pth' | Select-Object -First 1
if ($pth) {
  $lines = Get-Content -LiteralPath $pth.FullName
  $lines = $lines | Where-Object { $_ -notmatch '^#' -or $_ -match 'import site' }
  if ($lines -notcontains 'import site') { $lines += 'import site' }
  # 把产品代码目录（app\）写进 sys.path：embeddable Python **不会**自动把脚本所在
  # 目录加进 sys.path（正常 Python 会），不写这行，launch.py 里
  # `from agent_worker import ...` 直接 ModuleNotFoundError——服务永远起不来、
  # 连 harness.log 都不写（本机复现实测）。路径相对 python.exe 所在目录：
  # 安装后是 <安装目录>\runtimes\python\ → ..\..\app 即 <安装目录>\app。
  if ($lines -notcontains '..\..\app') { $lines += '..\..\app' }
  $lines | Set-Content -LiteralPath $pth.FullName -Encoding ASCII
  Say '    已调整 embeddable 的 sys.path 配置' 'Green'
}
Say ("    python: " + (& (Join-Path $pythonOut 'python.exe') -c "import sys;print(sys.version.split()[0])")) 'Green'
$hasSqlite = & (Join-Path $pythonOut 'python.exe') -c "import sqlite3;print('yes')" 2>$null
if ($hasSqlite -notmatch 'yes') { throw 'python 运行时缺少 sqlite3，不能用。' }
Say '    sqlite3 可用' 'Green'
}

# -- 3. 取密钥/解密组件 ------------------------------------------------------
# 注：**不再打包取密钥/解密组件**。本项目不接触密钥与解密 —— 解锁由外部完成，
# 产物是一个符合 docs/unlocked-db-protocol.md 的"已解锁目录"。因此安装包不再携带
# 任何解密代码（这一条是"隔离"能否成立的硬要求：包里有，就等于你仍在分发手段）。

# -- 3.4 语音解码组件（发送必需）---------------------------------------------
# install.ps1 里是硬要求：缺了会 Die，客户装不下去（实测踩到：母包里没有 components\silk）。
Step '语音解码组件'
$silkSource = Join-Path $RepoRoot 'packaging\components\silk'
if (-not (Test-Path -LiteralPath (Join-Path $silkSource 'silk-decoder-x64.exe'))) {
  throw "缺少语音解码组件：$silkSource\silk-decoder-x64.exe（发送消息必需，install.ps1 会拒绝安装）"
}
$silkOut = Join-Path $package 'components\silk'
New-Item -ItemType Directory -Force -Path $silkOut | Out-Null
# 注意必须用 -Path 而不是 -LiteralPath：-LiteralPath 不做通配展开，`*\` 会被当成
# 一个字面文件名叫 '*' 的东西（复制 0 个文件，install.ps1 会直接拒绝安装——实测踩到）。
Copy-Item -Path (Join-Path $silkSource '*') -Destination $silkOut -Force
Say ("    components\silk  {0} 个文件" -f @(Get-ChildItem -LiteralPath $silkOut -File).Count) 'Green'

# -- 3.5 消息运行时（客户拿一个包就够） ---------------------------------------
# 运行时是**启动硬前提**：launch.py 要读它的 .runtime-data\shared-service.json 拿 token，
# 发送也全靠它。以前它要单独装，客户拿到本包也起不来 —— 这里直接打进去。
Step '消息运行时'
if ($SkipRuntime -or $AppOnly) {
  Say '    按要求跳过（客户拿到的包将不含消息运行时，发不出消息）' 'Yellow'
} elseif (-not $RuntimePackage) {
  $guess = Join-Path (Split-Path $RepoRoot -Parent) 'messaging-runtime\artifacts\packages'
  if (Test-Path -LiteralPath $guess) {
    $RuntimePackage = (Get-ChildItem -LiteralPath $guess -Directory |
                       Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
  }
}
$runtimeOut = Join-Path $package 'components\messaging-runtime'
if (-not $SkipRuntime -and -not $AppOnly) {
if (-not $RuntimePackage -or -not (Test-Path -LiteralPath (Join-Path $RuntimePackage 'artifacts\app\messaging-runtime.dll'))) {
  throw @'
没有可打包的消息运行时。先就地构建它（自包含，客户机不用装 .NET）：

    cd <messaging-runtime>
    powershell -ExecutionPolicy Bypass -File tools\package.ps1 -SelfContained
    # 产出：artifacts\packages\messaging-runtime-<时间戳>\

然后把那个目录用 -RuntimePackage <目录> 指定给本脚本。
（确实不想带运行时、只给自己做实验，可以加 -SkipRuntime。）
'@
}
New-Item -ItemType Directory -Force -Path $runtimeOut | Out-Null
foreach ($name in 'artifacts','tools','config','runtime') {
  $from = Join-Path $RuntimePackage $name
  if (Test-Path -LiteralPath $from) {
    Copy-Item -LiteralPath $from -Destination (Join-Path $runtimeOut $name) -Recurse -Force
  }
}
foreach ($file in 'README.md') {
  $from = Join-Path $RuntimePackage $file
  if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $runtimeOut -Force }
}
Get-ChildItem -LiteralPath $runtimeOut -Recurse -Force -Directory |
  Where-Object { $_.Name -eq '__pycache__' } | ForEach-Object {
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
$rtMB = [math]::Round(((Get-ChildItem -LiteralPath $runtimeOut -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 0)
$selfContained = Test-Path -LiteralPath (Join-Path $runtimeOut 'artifacts\app\coreclr.dll')
Say ("    components\messaging-runtime  {0} MB（{1}）" -f $rtMB,
     $(if ($selfContained) { '自包含，客户机不需要装 .NET' } else { '依赖框架 —— 客户机需要装 .NET 8' })) $(if ($selfContained) { 'Green' } else { 'Yellow' })
}

# -- 4. 引擎 ----------------------------------------------------------------
Step '引擎'
if ($SkipEngine -or $AppOnly) {
  New-Item -ItemType Directory -Force -Path (Join-Path $package 'engine') | Out-Null
  Set-Content -LiteralPath (Join-Path $package 'engine\README-引擎未打包.txt') -Encoding UTF8 -Value @'
这个包里没有消息引擎（构建时加了 -SkipEngine）。
只在自己机器上做实验时这样用；发给别人的包必须带引擎。
'@
  Say '    按要求跳过引擎' 'Yellow'
} else {
  $engineOut = Join-Path $package 'engine'
  New-Item -ItemType Directory -Force -Path $engineOut | Out-Null
  $engineFingerprint = ''
  # 引擎两种形态：
  #  ① 构建产物（build-engine-deploy.ps1 的部署目录，lib\bin.js 在根部）：自包含、
  #     无符号链接 → 直接 robocopy，秒级；安装时也只是一次 robocopy。
  #  ② TS 源码仓（apps\cli\src\bin.ts）：带 pnpm 符号链接树，只能打 tar 走归档
  #     （约 10 分钟，安装时还要重建 1.8 万链接）。仅当没有构建产物时才走。
  if (Test-Path -LiteralPath (Join-Path $EngineRoot 'lib\bin.js')) {
    $engineTarget = Join-Path $engineOut 'harness'
    # 先裁掉 pnpm deploy 混进来的 dev 工具链（vitest/eslint/mermaid/typescript/@aws-sdk…
    # 实测占引擎体积一半、文件数三分之一 —— 打包、解压、安装全都在为它们买单）。
    # 幂等：已裁过的目录再跑一次秒级过。详见 flatten_engine_modules.py 的注释。
    $pruneScript = Join-Path $PSScriptRoot 'flatten_engine_modules.py'
    $engineRepo = Join-Path (Split-Path $RepoRoot -Parent) 'deepseek-harness'
    if (Test-Path -LiteralPath (Join-Path $engineRepo 'packages\bundle')) {
      $py = Get-Command python -ErrorAction SilentlyContinue
      if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
      if ($py) {
        Say '    裁剪引擎运行时闭包（dev 工具链）…' 'DarkGray'
        & $py.Source $pruneScript --prune $EngineRoot $engineRepo
        if ($LASTEXITCODE -ne 0) { throw "引擎裁剪失败（flatten_engine_modules.py 退出码 $LASTEXITCODE）" }
      } else {
        Say '    [!] 找不到 python，跳过引擎裁剪（包会比需要的大很多）' 'Yellow'
      }
    } else {
      Say "    [!] 找不到引擎源码仓（$engineRepo），跳过引擎裁剪" 'Yellow'
    }
    Say '    引擎是构建产物（部署目录），直接复制…' 'DarkGray'
    New-Item -ItemType Directory -Force -Path $engineTarget | Out-Null
    & robocopy $EngineRoot $engineTarget /E /MT:16 /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "复制引擎失败（robocopy 退出码 $LASTEXITCODE）" }
    foreach ($must in 'lib\bin.js', 'node_modules') {
      if (-not (Test-Path -LiteralPath (Join-Path $engineTarget $must))) { throw "引擎复制后缺少 $must，中止打包。" }
    }
    # 引擎变更指纹：lib 入口块 + package.json（引擎重建/重新 deploy 必变）。
    # 给 install.ps1 判断"引擎变没变"用，作用等价于 tar 流程里归档的 sha256。
    $combined = (@(Get-ChildItem -LiteralPath (Join-Path $engineTarget 'lib') -File | Sort-Object Name |
                   ForEach-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }) +
                 @((Get-FileHash -LiteralPath (Join-Path $engineTarget 'package.json') -Algorithm SHA256).Hash)) -join ''
    $engineFingerprint = [BitConverter]::ToString(
      [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($combined))
    ).Replace('-', '').ToLower()
    $engineMB = (Get-ChildItem -LiteralPath $engineTarget -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
    Say ("    engine\harness -> {0:N0} MB（构建产物，指纹 {1}…）" -f $engineMB, $engineFingerprint.Substring(0, 12)) 'Green'
  } else {
  if (-not (Test-Path -LiteralPath (Join-Path $EngineRoot 'apps\cli\src\bin.ts'))) { throw "引擎目录不对：$EngineRoot" }
  $tarPath = Join-Path $engineOut 'harness.tar'
  #
  # 为什么要打成 tar 而不是复制目录：
  #  engine 有 7.4 万个文件（其中 node_modules 5.6 万），逐文件复制在慢盘上实测只有
  #  ~28 文件/秒（3 MB/s），要 45 分钟以上；`tar -cf` 一次写一个流实测 121 文件/秒，
  #  快 4 倍，而且**交付物只有一个文件**，看起来也干净，安装时一次解包即可。
  #  Windows 10 起自带 bsdtar（tar.exe），不额外依赖。
  #
  #
  Say '    处理引擎归档…' 'DarkGray'
  $reuse = (Test-Path -LiteralPath $tarPath) -and ((Get-Item -LiteralPath $tarPath).Length -gt 100MB) -and -not $ForceEngine
  if ($reuse) {
    Say '    复用已有归档（要重打加 -ForceEngine）' 'DarkGray'
  } else {
    Say '    正在打成单个归档（约 10 分钟，请耐心等）…' 'DarkGray'
    if (Test-Path -LiteralPath $tarPath) { Remove-Item -LiteralPath $tarPath -Force }
    # 排除开发用的东西：agent 笔记、CI、测试快照、编辑器配置。运行时不需要。
    # **必须排除 ./\.env**：引擎根的 .env 存着开发者的真实 API key —— 曾经原样打进
    # 客户包（874MB 归档里躺着密钥，实测发现）。也绝不要靠"清空再打"来补救，直接排除。
    # website/ 是文档站、dist-exe/ 是 python sdk 的可执行构建产物，运行时都用不到。
    # 不加 -L（跟随链接）：pnpm 的链接**都是相对路径**（如
    # `.pnpm\tsx@4.22.4\node_modules\tsx`、`../../../../node_modules/.pnpm/...`），
    # 原样存成链接后解包仍能正确解析 —— 而且省掉几倍的重复内容。
    $excludes = @('--exclude=./.git', '--exclude=./.github', '--exclude=./.agents', '--exclude=./.claude',
                  '--exclude=./.env', '--exclude=./.dsh-build', '--exclude=./website', '--exclude=./dist-exe',
                  '--exclude=./snapshots', '--exclude=./coverage', '--exclude=*.tsbuildinfo')
    & tar -cf $tarPath @excludes -C $EngineRoot .
    if ($LASTEXITCODE -ne 0) { throw "打包引擎失败（tar 退出码 $LASTEXITCODE）" }
    if (-not (Test-Path -LiteralPath $tarPath)) { throw '引擎归档没有生成。' }
    # 打好的归档顺手存进固定缓存：下次换 -OutDir 也不用再等 10 分钟。
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    Copy-Item -LiteralPath $tarPath -Destination $tarCache -Force
    Say ("    归档已存入缓存：{0}" -f $tarCache) 'DarkGray'
  }
  $tarMB = (Get-Item -LiteralPath $tarPath).Length / 1MB

  # 自检：入口必须是个真文件；tsx 在归档里是**符号链接**，所以不能按
  # `node_modules/tsx/package.json` 去找（第一次就是这么误报"缺少 tsx"的），
  # 要按它真正落地的位置找：.pnpm 里的实体。
  $listing = & tar -tf $tarPath
  if ($listing -notcontains './apps/cli/src/bin.ts') { throw '引擎归档里缺少 ./apps/cli/src/bin.ts，中止打包。' }
  $hasTsx = ($listing | Where-Object { $_ -match '^\./node_modules/\.pnpm/tsx@[^/]+/node_modules/tsx/package\.json$' } | Select-Object -First 1)
  if (-not $hasTsx) { throw '引擎归档里没有 tsx（.pnpm 下的实体），中止打包。' }
  Say ("    engine\harness.tar -> {0:N0} MB（已排除 .git/.github/.agents/.claude/snapshots）" -f $tarMB) 'Green'
  }
}

# -- 5. 脚本与说明 ----------------------------------------------------------
Step '复制安装脚本与说明'
# **按类型整体复制，不列白名单**。之前是手写清单，结果 install.ps1 里加了脚本、
# 这里忘加 —— 装完第 7 步报"脚本不存在"。这类清单漂移只能靠"不列清单"根治。
# setup.cmd 例外：它是放在 zip **旁边**交付的免解压一键安装器，不属于包内容。
$copied = 0
foreach ($file in (Get-ChildItem -LiteralPath $PSScriptRoot -File |
    Where-Object { $_.Extension -in '.ps1', '.py', '.cmd', '.md', '.json' -and $_.Name -notin 'build-package.ps1', 'setup.cmd' })) {
  Copy-Item -LiteralPath $file.FullName -Destination $package -Force
  $copied++
}
if (-not (Test-Path -LiteralPath (Join-Path $package 'install.ps1'))) { throw '安装脚本没有复制进包，中止。' }
# PowerShell 5.1 读取 .ps1 时，没有 BOM 就按 ANSI(GBK) 解释 —— 脚本里的中文会变成乱码，
# 而且常常直接**语法错误**（引号被吃掉、字符串缺终止符），报错信息还完全看不懂。
# 这里统一补 BOM，避免"用别的编辑器改一下就装不了"。
foreach ($script in (Get-ChildItem -LiteralPath $package -Filter '*.ps1' -File)) {
  $text = [IO.File]::ReadAllText($script.FullName, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($script.FullName, $text, [Text.UTF8Encoding]::new($true))
}
Say ("    脚本与说明 {0} 个（已统一 UTF-8 BOM）" -f $copied) 'Green'

# -- 6. 清单 ----------------------------------------------------------------
Step '生成 manifest.json'
# 版本号来自 -Version 参数（见 param 区）。
# git 的 stderr 在 PowerShell 里会被当成错误记录，$ErrorActionPreference='Stop' 下会直接
# 中断脚本（实测：仓库报 dubious ownership，打包就停在最后一步）。
# 版本号是"尽力而为"的信息，取不到就写 unknown，不该让打包失败。
function Git-Rev([string]$Path) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $result = & git -C $Path rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $result) { return ("$result").Trim() }
  } catch { } finally { $ErrorActionPreference = $previous }
  return 'unknown'
}
$repoHead = Git-Rev $RepoRoot
# 升级小包不带运行时也不带引擎，版本号和引擎哈希从上一次完整构建的记录里抄
#（.cache\last-full-build.json，完整打包结束时写）。没有记录就不许出小包 ——
# 否则装出去的 manifest 缺版本信息，install.ps1 没法校验"沿用是否安全"。
$lastBuildPath = Join-Path $cacheDir 'last-full-build.json'
$lastBuild = [ordered]@{}
if (Test-Path -LiteralPath $lastBuildPath) {
  try { $lastBuild = Get-Content -LiteralPath $lastBuildPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $lastBuild = [ordered]@{} }
}
if ($AppOnly -and (-not $lastBuild.node -or -not $lastBuild.python -or -not $lastBuild.engineSha)) {
  throw '出升级小包前必须先完整打包一次（引擎哈希与运行时版本记录在 .cache\last-full-build.json）。'
}
$files = @()
$engineTarSha = ''
if (-not $engineFingerprint) { $engineFingerprint = '' }
if (-not $SkipHashes) {
  # 引擎是单个归档，所以这里**不做例外**都要算哈希 —— 最大的那块恰恰最需要可校验。
  # 但全量 SHA256 一次要 8 分钟，而重复打包时绝大多数文件（引擎归档、运行时、
  # 消息运行时）和上次构建一字不差。哈希缓存按（相对路径 + 大小 + LastWriteTimeUtc）
  # 命中 —— Copy-Item/robocopy 都保留源文件的修改时间，所以键跨构建稳定；
  # 内容变了的文件大小或时间必然变，不会被误命中。
  $hashCachePath = Join-Path $cacheDir 'file-hashes.json'
  $hashCache = @{}
  if (Test-Path -LiteralPath $hashCachePath) {
    try {
      $stored = Get-Content -LiteralPath $hashCachePath -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($prop in $stored.PSObject.Properties) { $hashCache[$prop.Name] = $prop.Value }
    } catch { Say '    哈希缓存读不了，本次全量计算' 'DarkGray' }
  }
  $all = Get-ChildItem -LiteralPath $package -Recurse -File
  $i = 0; $reused = 0
  foreach ($f in $all) {
    $i++
    if ($i % 200 -eq 0) { Write-Host ("    已算 $i / $($all.Count)") -ForegroundColor DarkGray }
    $rel = $f.FullName.Substring($package.Length + 1).Replace('\', '/')
    $mt = $f.LastWriteTimeUtc.ToString('o')
    $sha = $null
    $hit = $hashCache[$rel]
    if ($hit -and ("$($hit.bytes)" -eq "$($f.Length)") -and ("$($hit.mtime)" -eq $mt)) { $sha = "$($hit.sha256)"; $reused++ }
    if (-not $sha) {
      $sha = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower()
      $hashCache[$rel] = [ordered]@{ bytes = $f.Length; mtime = $mt; sha256 = $sha }
    }
    if ($rel -eq 'engine/harness.tar') { $engineTarSha = $sha }
    $files += [ordered]@{ path = $rel; bytes = $f.Length; sha256 = $sha }
  }
  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  [IO.File]::WriteAllText($hashCachePath, ($hashCache | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
  Say ("    哈希：{0} 个文件，复用缓存 {1} 个" -f $files.Count, $reused) 'DarkGray'
}
$nodeVersion = if ($AppOnly) { "$($lastBuild.node)" } else { (& (Join-Path $nodeOut 'node.exe') '-v') }
$pythonVersion = if ($AppOnly) { "$($lastBuild.python)" } else { (& (Join-Path $pythonOut 'python.exe') -c "import sys;print(sys.version.split()[0])") }
$engineShaForManifest = if ($AppOnly) { "$($lastBuild.engineSha)" }
                        elseif ($engineFingerprint) { $engineFingerprint }
                        else { $engineTarSha }
$manifest = [ordered]@{
  product = 'MessageAgent'
  version = $version
  packageKind = $(if ($AppOnly) { 'app-only' } else { 'full' })
  built_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  platform = 'windows-x64'
  components = [ordered]@{
    app = [ordered]@{ repo = 'message-agent'; revision = "$repoHead" }
    engine = [ordered]@{ mode = $(if ($SkipEngine -or $AppOnly) { 'external' } else { 'bundled' }); path = $EngineRoot; sha = $engineShaForManifest }
    node = [ordered]@{ version = "$nodeVersion" }
    python = [ordered]@{ version = "$pythonVersion" }
  }
  files = $files
}
[IO.File]::WriteAllText((Join-Path $package 'manifest.json'),
  ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
Say ("    manifest.json：{0} 个文件（引擎哈希：{1}）" -f $files.Count, $engineShaForManifest) 'Green'
# 完整打包的指纹（引擎哈希 + 运行时版本）记下来：升级小包从这里抄进自己的 manifest，
# install.ps1 才能对客户机说"引擎/运行时没变，沿用"。
if (-not $AppOnly) {
  [IO.File]::WriteAllText($lastBuildPath,
    ([ordered]@{ built_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
                 engineSha = $engineShaForManifest; node = "$nodeVersion"; python = "$pythonVersion" } | ConvertTo-Json),
    [Text.UTF8Encoding]::new($false))
}

$size = (Get-ChildItem -LiteralPath $package -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Say ''
Say ("打包完成：{0}" -f $package) 'Green'
Say ("总体积：{0:N1} MB" -f $size) 'Green'
Say ''
Say '下一步：' 'White'
Say ("  powershell -ExecutionPolicy Bypass -File `"$package\install.ps1`"") 'White'
Say '（引擎已随包提供，安装时不需要再指定 -EngineRoot）' 'DarkGray'

# -- 7. 打成单个交付文件（可选） ---------------------------------------------
if ($MakeZip) {
  Step '打成单个交付文件'
  # 交付物不能是一个文件夹：用户拿到的东西必须是一个文件。
  # 用 bsdtar 的 zip 写出（Windows 自带），实测 1.6 GB -> 483 MB、不到 1 分钟。
  # 先把目录改成产品名再压（zip 里就是 MessageAgent-0.1.0-win64/… 而不是 package/…），
  # 压完改回来，这样下次构建还能复用引擎归档。
  $zipName = if ($AppOnly) { "MessageAgent-app-$version-win64" } else { "MessageAgent-$version-win64" }
  $named = Join-Path $OutDir $zipName
  if (Test-Path -LiteralPath $named) { Remove-Item -LiteralPath $named -Recurse -Force -ErrorAction SilentlyContinue }
  Move-Item -LiteralPath $package -Destination $named -Force
  $zipPath = Join-Path $OutDir ($zipName + '.zip')
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  & tar -a -cf $zipPath -C $OutDir $zipName
  $code = $LASTEXITCODE
  Move-Item -LiteralPath $named -Destination $package -Force
  if ($code -ne 0) { throw "打成 zip 失败（tar 退出码 $code）" }
  $zipMB = (Get-Item -LiteralPath $zipPath).Length / 1MB
  Say '' 
  Say ("交付文件：{0}（{1:N0} MB）" -f $zipPath, $zipMB) 'Green'
  Say '  用户拿到这一个文件：解压 → 右键 install.ps1 → 使用 PowerShell 运行' 'White'
}

if ($LogTo) { try { Stop-Transcript | Out-Null } catch { } }
