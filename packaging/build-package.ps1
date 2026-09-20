<#
  组装可交付的安装包目录（给普通用户的那种）。

  产出：<OutDir>\package\
    app\                 产品本体（plugin/ agent_worker/ presets/ launch.py …）
    runtimes\node\       自带 Node（用户不需要自己装）
    runtimes\python\     自带 Python（用户不需要自己装）
    components\wechat-db-lab\src\   取密钥/解密组件
    engine\harness\      消息引擎（默认整包带走；-SkipEngine 可跳过）
    install.ps1 等脚本 + config.template.json + 安装说明.md
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
  [string]$DbLabRoot = '',
  [string]$NodeRuntime = '',
  [string]$PythonRuntime = '',
  [string]$NodeVersion = 'v22.23.0',
  [string]$PythonVersion = '3.13.12',
  [switch]$SkipEngine,
  [switch]$SkipHashes,
  [switch]$ForceEngine,
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
if (-not $DbLabRoot)  { $DbLabRoot = Join-Path (Split-Path $RepoRoot -Parent) 'wechat-db-lab' }
if (-not $EngineRoot) { $EngineRoot = Join-Path (Split-Path $RepoRoot -Parent) 'deepseek-harness' }

$ErrorActionPreference = 'Stop'
# 下载/解压的进度条会把输出刷成几万行，日志完全没法看（实测）。关掉。
$ProgressPreference = 'SilentlyContinue'
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Step($t) { Say ''; Say "== $t" 'Cyan' }

$package = Join-Path $OutDir 'package'
# 引擎归档 1.5GB、重打要 8 分钟，清理旧包前先把它挪到旁边，清理完再放回。
# （不加 -ForceEngine 时复用；这也是"改个脚本重打包"能几分钟搞定的原因。）
$tarCache = Join-Path $OutDir 'harness.tar.cache'
$existingTar = Join-Path $package 'engine\harness.tar'
if ((Test-Path -LiteralPath $existingTar) -and -not $ForceEngine -and -not $SkipEngine) {
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  Move-Item -LiteralPath $existingTar -Destination $tarCache -Force
  Say ''; Say "复用上次打好的引擎归档（改包不重打；要重打加 -ForceEngine）" 'DarkGray'
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
if (Test-Path -LiteralPath $tarCache) {
  New-Item -ItemType Directory -Force -Path (Join-Path $package 'engine') | Out-Null
  Move-Item -LiteralPath $tarCache -Destination (Join-Path $package 'engine\harness.tar') -Force
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
if ($SkipEngine) {
  New-Item -ItemType Directory -Force -Path (Join-Path $package 'engine') | Out-Null
  Set-Content -LiteralPath (Join-Path $package 'engine\README-引擎未打包.txt') -Encoding UTF8 -Value @'
这个包里没有消息引擎（构建时加了 -SkipEngine）。
只在自己机器上做实验时这样用；发给别人的包必须带引擎。
'@
  Say '    按要求跳过引擎' 'Yellow'
} else {
  if (-not (Test-Path -LiteralPath (Join-Path $EngineRoot 'apps\cli\src\bin.ts'))) { throw "引擎目录不对：$EngineRoot" }
  $engineOut = Join-Path $package 'engine'
  New-Item -ItemType Directory -Force -Path $engineOut | Out-Null
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
    # 不加 -L（跟随链接）：pnpm 的链接**都是相对路径**（如
    # `.pnpm\tsx@4.22.4\node_modules\tsx`、`../../../../node_modules/.pnpm/...`），
    # 原样存成链接后解包仍能正确解析 —— 而且省掉几倍的重复内容。
    $excludes = @('--exclude=./.git', '--exclude=./.github', '--exclude=./.agents', '--exclude=./.claude',
                  '--exclude=./snapshots', '--exclude=./coverage', '--exclude=*.tsbuildinfo')
    & tar -cf $tarPath @excludes -C $EngineRoot .
    if ($LASTEXITCODE -ne 0) { throw "打包引擎失败（tar 退出码 $LASTEXITCODE）" }
    if (-not (Test-Path -LiteralPath $tarPath)) { throw '引擎归档没有生成。' }
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

# -- 5. 脚本与说明 ----------------------------------------------------------
Step '复制安装脚本与说明'
# **按类型整体复制，不列白名单**。之前是手写清单，结果 install.ps1 里加了
# wechat_keys.py / read-wechat-keys.ps1，这里忘加 —— 装完第 7 步报"脚本不存在"。
# 这类清单漂移只能靠"不列清单"根治。
$copied = 0
foreach ($file in (Get-ChildItem -LiteralPath $PSScriptRoot -File |
    Where-Object { $_.Extension -in '.ps1', '.py', '.cmd', '.md', '.json' -and $_.Name -ne 'build-package.ps1' })) {
  Copy-Item -LiteralPath $file.FullName -Destination $package -Force
  $copied++
}
if (-not (Test-Path -LiteralPath (Join-Path $package 'install.ps1'))) { throw '安装脚本没有复制进包，中止。' }
if (-not (Test-Path -LiteralPath (Join-Path $package 'wechat_keys.py'))) { throw 'wechat_keys.py 没有复制进包，中止。' }
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
  # 引擎是单个归档，所以这里**不做例外**都要算哈希 —— 最大的那块恰恰最需要可校验。
  $all = Get-ChildItem -LiteralPath $package -Recurse -File
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
    engine = [ordered]@{ mode = $(if ($SkipEngine) { 'external' } else { 'bundled' }); path = $EngineRoot }
    node = [ordered]@{ version = (& (Join-Path $nodeOut 'node.exe') '-v') }
    python = [ordered]@{ version = (& (Join-Path $pythonOut 'python.exe') -c "import sys;print(sys.version.split()[0])") }
  }
  files = $files
}
[IO.File]::WriteAllText((Join-Path $package 'manifest.json'),
  ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
Say ("    manifest.json：{0} 个文件（含引擎归档的哈希）" -f $files.Count) 'Green'

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
  $zipName = "MessageAgent-$version-win64"
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
