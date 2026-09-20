<#
  组装可交付的安装包目录（给普通用户的那种）。

  产出：<OutDir>\package\
    app\                 产品本体（plugin/ agent_worker/ presets/ launch.py …）
    runtimes\node\       自带 Node（用户不需要自己装）
    runtimes\python\     自带 Python（用户不需要自己装）
    components\wechat-db-lab\src\   取密钥/解密组件
    engine\harness\      消息引擎（用 -IncludeEngine 时打包；见文末说明）
    install.ps1 等脚本 + config.template.json + 安装说明.md
    manifest.json        版本与文件哈希清单

  用法：
    powershell -ExecutionPolicy Bypass -File build-package.ps1
    powershell -ExecutionPolicy Bypass -File build-package.ps1 -IncludeEngine -EngineRoot C:\...\deepseek-harness
    powershell -ExecutionPolicy Bypass -File build-package.ps1 -NodeRuntime <node目录> -PythonRuntime <python目录>

  关于引擎：计划里建议交付「构建产物 + 依赖」。当前引擎仓库用 tsx 直接跑 TS 源码，
  完整可分发产物属于打包方案里的 P0（见 docs/packaging-plan.md §11），**本脚本不假装
  已经完成那一步**：只有显式给 -IncludeEngine 才会把引擎目录复制进来（体积很大）。
#>
[CmdletBinding()]
param(
  # 注意：这些默认值**不能**写成 Join-Path $PSScriptRoot ... ——
  # Windows PowerShell 5.1 在解析 param 默认值时 $PSScriptRoot 还是空的（实测报错
  # "参数为空字符串"）。所以统一留空，进函数体再解析。
  [string]$OutDir = '',
  [string]$RepoRoot = '',
  [string]$EngineRoot = '',
  [string]$DbLabRoot = '',
  [string]$NodeRuntime = '',
  [string]$PythonRuntime = '',
  [string]$NodeVersion = 'v22.23.0',
  [string]$PythonVersion = '3.13.12',
  [switch]$IncludeEngine,
  [switch]$SkipHashes
)

if (-not $OutDir)     { $OutDir = Join-Path $PSScriptRoot 'out' }
if (-not $RepoRoot)   { $RepoRoot = Split-Path $PSScriptRoot -Parent }
if (-not $DbLabRoot)  { $DbLabRoot = Join-Path (Split-Path $RepoRoot -Parent) 'wechat-db-lab' }
if (-not $EngineRoot) { $EngineRoot = Join-Path (Split-Path $RepoRoot -Parent) 'deepseek-harness' }

$ErrorActionPreference = 'Stop'
# 下载/解压的进度条会把输出刷成几万行，日志完全没法看（实测）。关掉。
$ProgressPreference = 'SilentlyContinue'
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Step($t) { Say ''; Say "== $t" 'Cyan' }

$package = Join-Path $OutDir 'package'
if (Test-Path -LiteralPath $package) { Remove-Item -LiteralPath $package -Recurse -Force }
New-Item -ItemType Directory -Force -Path $package | Out-Null

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
Get-ChildItem -LiteralPath $appOut -Recurse -Force -Directory |
  Where-Object { $_.Name -eq '__pycache__' } |
  Remove-Item -Recurse -Force
Get-ChildItem -LiteralPath $appOut -Recurse -Force -File |
  Where-Object { $_.Extension -eq '.pyc' -or $_.Name -like '*.test.mjs' } |
  Remove-Item -Force
$appFiles = (Get-ChildItem -LiteralPath $appOut -Recurse -Force -File).Count
if ($appFiles -lt 10) { throw "产品本体复制后只有 $appFiles 个文件，明显不对，中止打包以免发出空包。" }
Say ("    app\ -> {0:N0} KB，{1} 个文件" -f ((Get-ChildItem $appOut -Recurse -File | Measure-Object Length -Sum).Sum / 1KB), $appFiles) 'Green'

# -- 2. 运行时（自带，用户不用装） -------------------------------------------
Step '准备自带运行时'
$nodeOut = Join-Path $package 'runtimes\node'
$pythonOut = Join-Path $package 'runtimes\python'
New-Item -ItemType Directory -Force -Path $nodeOut, $pythonOut | Out-Null

if ($NodeRuntime) {
  Copy-Item -Path (Join-Path $NodeRuntime '*') -Destination $nodeOut -Recurse -Force
  Say "    node 来自本地：$NodeRuntime" 'Green'
} else {
  $zip = Join-Path $env:TEMP "node-$NodeVersion-win-x64.zip"
  if (-not (Test-Path -LiteralPath $zip)) {
    Say "    下载官方 Node $NodeVersion …" 'DarkGray'
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip" -OutFile $zip -UseBasicParsing
  }
  Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $env:TEMP 'ma-node-extract') -Force
  Copy-Item -Path (Join-Path $env:TEMP "ma-node-extract\node-$NodeVersion-win-x64\*") -Destination $nodeOut -Recurse -Force
  Say '    node 来自官方发行包' 'Green'
}
if (-not (Test-Path -LiteralPath (Join-Path $nodeOut 'node.exe'))) { throw "node 运行时里没有 node.exe（$nodeOut）" }
Say ("    node: " + (& (Join-Path $nodeOut 'node.exe') '-v')) 'Green'

if ($PythonRuntime) {
  Copy-Item -Path (Join-Path $PythonRuntime '*') -Destination $pythonOut -Recurse -Force
  Say "    python 来自本地：$PythonRuntime" 'Green'
} else {
  $zip = Join-Path $env:TEMP "python-$PythonVersion-embed-amd64.zip"
  if (-not (Test-Path -LiteralPath $zip)) {
    Say "    下载官方 Python $PythonVersion（embeddable）…" 'DarkGray'
    Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" -OutFile $zip -UseBasicParsing
  }
  Expand-Archive -LiteralPath $zip -DestinationPath $pythonOut -Force
  Say '    python 来自官方 embeddable 包' 'Green'
}
if (-not (Test-Path -LiteralPath (Join-Path $pythonOut 'pythonw.exe'))) { throw "python 运行时里没有 pythonw.exe（$pythonOut）" }

# embeddable 包默认用 ._pth 隔离 sys.path：允许 import 工作目录，worker 才能 import agent_worker
$pth = Get-ChildItem -LiteralPath $pythonOut -Filter 'python*._pth' | Select-Object -First 1
if ($pth) {
  $lines = Get-Content -LiteralPath $pth.FullName
  $lines = $lines | Where-Object { $_ -notmatch '^#' -or $_ -match 'import site' }
  if ($lines -notcontains 'import site') { $lines += 'import site' }
  $lines | Set-Content -LiteralPath $pth.FullName -Encoding ASCII
  Say '    已调整 embeddable 的 sys.path 配置' 'Green'
}
Say ("    python: " + (& (Join-Path $pythonOut 'python.exe') -c "import sys;print(sys.version.split()[0])")) 'Green'
$hasSqlite = & (Join-Path $pythonOut 'python.exe') -c "import sqlite3;print('yes')" 2>$null
if ($hasSqlite -notmatch 'yes') { throw 'python 运行时缺少 sqlite3，不能用。' }
Say '    sqlite3 可用' 'Green'

# -- 3. 取密钥/解密组件 ------------------------------------------------------
Step '复制取密钥/解密组件'
$dblabOut = Join-Path $package 'components\wechat-db-lab'
New-Item -ItemType Directory -Force -Path $dblabOut | Out-Null
Copy-Item -LiteralPath (Join-Path $DbLabRoot 'src') -Destination $dblabOut -Recurse -Force
Get-ChildItem -LiteralPath $dblabOut -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force
Say '    components\wechat-db-lab\src' 'Green'

# -- 4. 引擎 ----------------------------------------------------------------
Step '引擎'
if ($IncludeEngine) {
  if (-not (Test-Path -LiteralPath (Join-Path $EngineRoot 'apps\cli\src\bin.ts'))) { throw "引擎目录不对：$EngineRoot" }
  $engineOut = Join-Path $package 'engine\harness'
  New-Item -ItemType Directory -Force -Path $engineOut | Out-Null
  # 只带运行时需要的东西：源码、依赖、配置；不要 .git、测试快照和缓存。
  foreach ($name in 'apps', 'packages', 'node_modules', 'package.json', 'pnpm-workspace.yaml', 'tsconfig.base.json') {
    $src = Join-Path $EngineRoot $name
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $engineOut -Recurse -Force }
  }
  foreach ($junk in '.git', '.storages', '.sessions', 'coverage') {
    Get-ChildItem -LiteralPath $engineOut -Recurse -Directory -Filter $junk -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
  }
  Say ("    engine\harness -> {0:N0} MB" -f ((Get-ChildItem $engineOut -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)) 'Yellow'
  Warn '提醒：这是「源码 + node_modules」形态，能跑但不是最终交付形态。'
  Say '    真正的构建产物属于打包方案 P0（docs/packaging-plan.md §11），做好之前不要把这份包发给用户。' 'Yellow'
} else {
  New-Item -ItemType Directory -Force -Path (Join-Path $package 'engine') | Out-Null
  Set-Content -LiteralPath (Join-Path $package 'engine\README-引擎未打包.txt') -Encoding UTF8 -Value @'
这个包里没有消息引擎。

引擎（deepseek-harness）需要先产出可分发的构建产物，见 docs/packaging-plan.md §11 的 P0。
在那之前：
  * 自己用：install.ps1 加参数 -EngineRoot <你的引擎目录>；
  * 打包给别人：build-package.ps1 加 -IncludeEngine（会带上源码 + node_modules，能跑但体积大）。
'@
  Say '    未打包引擎（用 -IncludeEngine 或安装时 -EngineRoot 指定）' 'Yellow'
}

# -- 5. 脚本与说明 ----------------------------------------------------------
Step '复制安装脚本与说明'
foreach ($f in 'install.ps1', 'start.ps1', 'stop.ps1', 'restart.ps1', 'uninstall.ps1',
               'MessageAgent.cmd', 'config.template.json', 'make_config.py') {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $f) -Destination $package -Force
}
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot '安装说明.md')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot '安装说明.md') -Destination $package -Force
}
# PowerShell 5.1 读取 .ps1 时，没有 BOM 就按 ANSI(GBK) 解释 —— 脚本里的中文会变成乱码，
# 而且常常直接**语法错误**（引号被吃掉、字符串缺终止符），报错信息还完全看不懂。
# 这里统一补 BOM，避免"用别的编辑器改一下就装不了"。
foreach ($script in (Get-ChildItem -LiteralPath $package -Filter '*.ps1' -File)) {
  $text = [IO.File]::ReadAllText($script.FullName, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($script.FullName, $text, [Text.UTF8Encoding]::new($true))
}
Say '    install/start/stop/restart/uninstall + 说明（已统一 UTF-8 BOM）' 'Green'

# -- 6. 清单 ----------------------------------------------------------------
Step '生成 manifest.json'
$version = '0.1.0'
# git 的 stderr 在 PowerShell 里会被当成错误记录，$ErrorActionPreference='Stop' 下会直接
# 中断脚本（实测：wechat-db-lab 仓库报 dubious ownership，打包就停在最后一步）。
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
$dbLabHead = Git-Rev $DbLabRoot
$files = @()
if (-not $SkipHashes) {
  $all = Get-ChildItem -LiteralPath $package -Recurse -File |
    Where-Object { $_.FullName -notmatch '\\engine\\harness\\node_modules\\' }
  $i = 0
  foreach ($f in $all) {
    $i++
    if ($i % 200 -eq 0) { Write-Host ("    已算 $i / $($all.Count)") -ForegroundColor DarkGray }
    $files += [ordered]@{
      path = $f.FullName.Substring($package.Length + 1).Replace('\', '/')
      bytes = $f.Length
      sha256 = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower()
    }
  }
}
$manifest = [ordered]@{
  product = 'MessageAgent'
  version = $version
  built_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  platform = 'windows-x64'
  components = [ordered]@{
    app = [ordered]@{ repo = 'message-agent'; revision = "$repoHead" }
    'wechat-db-lab' = [ordered]@{ repo = 'wechat-db-lab'; revision = "$dbLabHead" }
    engine = [ordered]@{ mode = $(if ($IncludeEngine) { 'bundled' } else { 'external' }); path = $EngineRoot }
    node = [ordered]@{ version = (& (Join-Path $nodeOut 'node.exe') '-v') }
    python = [ordered]@{ version = (& (Join-Path $pythonOut 'python.exe') -c "import sys;print(sys.version.split()[0])") }
  }
  files = $files
}
[IO.File]::WriteAllText((Join-Path $package 'manifest.json'),
  ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
Say ("    manifest.json：{0} 个文件（引擎的 node_modules 不计入）" -f $files.Count) 'Green'

$size = (Get-ChildItem -LiteralPath $package -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Say ''
Say ("打包完成：{0}" -f $package) 'Green'
Say ("总体积：{0:N1} MB" -f $size) 'Green'
Say ''
Say '下一步（自己用）：' 'White'
Say ("  powershell -ExecutionPolicy Bypass -File `"$package\install.ps1`" -EngineRoot <引擎目录>") 'White'
