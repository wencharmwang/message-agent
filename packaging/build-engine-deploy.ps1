<#
  构建引擎的"部署目录"（P1 根治方案的引擎侧产物）。

  产出：<EngineRoot>\artifacts\web-deploy\   —— 一个自包含、无符号链接的引擎目录：
    lib\bin.js          构建好的 CLI 入口（普通 node 直接跑，不需要 tsx/TypeScript）
    node_modules\       扁平的真实目录（flatten_engine_modules.py 拍平 + 补齐）
    package.json        dsh CLI 的 manifest

  对比旧方案（TS 源码 + pnpm 全量 node_modules 打成 874MB tar）：
    - 体积从 ~874MB 降到 ~100-300MB（dev 依赖、源码、文档全不带）
    - 没有符号链接 → 打包直接 robocopy，不再需要 tar + extract_engine.py 重建 1.8 万链接
    - launch.py 直接 node lib\bin.js，启动快

  用法：
    powershell -ExecutionPolicy Bypass -File build-engine-deploy.ps1
    powershell -ExecutionPolicy Bypass -File build-engine-deploy.ps1 -SkipBuild   # 引擎已有构建产物时
  然后给 build-package.ps1 传 -EngineRoot <EngineRoot>\artifacts\web-deploy。

  前置：corepack/pnpm 可用（package.json 里 packageManager 声明了 pnpm 版本），
  引擎仓已 pnpm install 过。引擎随上游升级后需要重跑本脚本。
#>
[CmdletBinding()]
param(
  [string]$EngineRoot = '',
  [string]$OutDir = '',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Step($t) { Say ''; Say "== $t" 'Cyan' }

if (-not $EngineRoot) { $EngineRoot = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'deepseek-harness' }
if (-not (Test-Path -LiteralPath (Join-Path $EngineRoot 'package.json'))) { throw "引擎仓目录不对：$EngineRoot" }
if (-not $OutDir) { $OutDir = Join-Path $EngineRoot 'artifacts\web-deploy' }

# pnpm 走 corepack（引擎 package.json 的 packageManager 锁版本）。
# 注意**不要**用 `npx corepack@latest pnpm`：它解析到的 pnpm 不看 packageManager，
# --filter 会报 "No projects matched the filters"（实测踩到）。要用 corepack 本体。
function Invoke-Pnpm([string[]]$Rest) {
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($pnpm) { & pnpm @Rest }
  else {
    $corepack = Get-Command corepack -ErrorAction SilentlyContinue
    if ($corepack) { & corepack pnpm @Rest }
    else { throw '找不到 pnpm/corepack。先把 node 目录加进 PATH。' }
  }
  if ($LASTEXITCODE -ne 0) { throw "pnpm $($Rest -join ' ') 失败（退出码 $LASTEXITCODE）" }
}

# -- 1. 引擎构建（lib + web 前端） ------------------------------------------
if ($SkipBuild) {
  Step '跳过引擎构建（-SkipBuild）'
  if (-not (Test-Path -LiteralPath (Join-Path $EngineRoot 'apps\cli\lib\bin.js'))) {
    throw '引擎还没有构建产物（apps\cli\lib\bin.js）。去掉 -SkipBuild 先构建。'
  }
} else {
  Step '构建引擎（pnpm build）'
  Push-Location $EngineRoot
  try { Invoke-Pnpm @('run', 'build') } finally { Pop-Location }
}

# -- 2. pnpm deploy 产出依赖闭包 --------------------------------------------
Step 'pnpm deploy --prod（自包含闭包）'
if (Test-Path -LiteralPath $OutDir) {
  # 清理不能用 Remove-Item：包里可能有超长路径；拿空目录 robocopy /MIR 过去。
  $empty = Join-Path $env:TEMP ('ma-empty-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $empty | Out-Null
  & robocopy $empty $OutDir /MIR /NFL /NDL /NJH /NJS /R:0 /W:0 | Out-Null
  Remove-Item -LiteralPath $OutDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $OutDir) { throw "清理旧部署目录失败：$OutDir" }
}
Push-Location $EngineRoot
try {
  # pnpm 11 的 deploy 默认 injected 模式，前提是 workspace 开启 inject-workspace-packages。
  # **绝不能 --prod --legacy**：这个组合实测会把源 workspace 的所有包目录清空
  # （今天两次，每次 4405 个跟踪文件被删），只认 injected 模式（--prod 不带 --legacy）。
  # 临时写 .npmrc 开启 inject，deploy 完还原（不动引擎自己的 .npmrc）。
  $npmrcPath = Join-Path $EngineRoot '.npmrc'
  $hadNpmrc = Test-Path -LiteralPath $npmrcPath
  $backup = ''
  if ($hadNpmrc) { $backup = [IO.File]::ReadAllText($npmrcPath) }
  try {
    [IO.File]::AppendAllText($npmrcPath, "`ninject-workspace-packages=true`n", [Text.UTF8Encoding]::new($false))
    $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($pnpmCmd) { & pnpm --filter '@deepseek-ai/dsh' deploy --prod $OutDir }
    else { & corepack pnpm --filter '@deepseek-ai/dsh' deploy --prod $OutDir }
  } finally {
    if ($hadNpmrc) { [IO.File]::WriteAllText($npmrcPath, $backup, [Text.UTF8Encoding]::new($false)) }
    else { Remove-Item -LiteralPath $npmrcPath -Force -ErrorAction SilentlyContinue }
  }
} finally { Pop-Location }
if (-not (Test-Path -LiteralPath (Join-Path $OutDir 'lib\bin.js'))) {
  throw "pnpm deploy 没有产出 lib\bin.js（$OutDir）"
}
# 实测 pnpm deploy --legacy 会把目标目录**再写一份**到 vendor\schemastery\artifacts\ 下
# （同名目录，原因不明）。清掉这份污染，别让它混进源码仓。
$leaf = Split-Path $OutDir -Leaf
Get-ChildItem -LiteralPath (Join-Path $EngineRoot 'vendor') -Directory -ErrorAction SilentlyContinue |
  ForEach-Object {
    $junk = Join-Path $_.FullName ("artifacts\" + $leaf)
    if (Test-Path -LiteralPath $junk) {
      Microsoft.PowerShell.Management\Remove-Item -LiteralPath $junk -Recurse -Force -ErrorAction SilentlyContinue
      Say ("    清掉 pnpm deploy 写偏的目录：{0}" -f $junk) 'DarkGray'
    }
  }
Say '    deploy 闭包就位' 'Green'

# -- 3. 拍平 + 补齐 ---------------------------------------------------------
# pnpm 布局（符号链接 + .pnpm 容器）会让引擎启动时的依赖 BFS 建不全闭包，
# 而且 peer+dev 型运行时依赖（如 cordis-plugin-group）不在闭包里。
# flatten_engine_modules.py：拍平成真实目录 + 按 web profile 插件清单补齐
# （拍平时即过滤黑名单；--prune 再兜一遍 -SkipBuild 复用的旧产物）。
Step '拍平 node_modules 并补齐运行时闭包'
$flatten = Join-Path $PSScriptRoot 'flatten_engine_modules.py'
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $python) { throw '需要 python 运行 flatten_engine_modules.py' }
& $python.Source $flatten $OutDir $EngineRoot
if ($LASTEXITCODE -ne 0) { throw "flatten_engine_modules.py 失败（退出码 $LASTEXITCODE）" }
& $python.Source $flatten --prune $OutDir $EngineRoot
if ($LASTEXITCODE -ne 0) { throw "flatten_engine_modules.py --prune 失败（退出码 $LASTEXITCODE）" }

# -- 4. 自检 ----------------------------------------------------------------
Step '自检'
foreach ($must in 'lib\bin.js', 'node_modules\@deepseek-ai\dsh-app-boot\package.json',
                  'node_modules\@deepseek-ai\dsh-web-frontend\dist\index.html',
                  'node_modules\@deepseek-ai\cordis-plugin-group\package.json') {
  if (-not (Test-Path -LiteralPath (Join-Path $OutDir $must))) { throw "部署目录缺少 $must，构建不完整。" }
}
# 用 node 实测入口能起（--version）
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $v = & $node.Source (Join-Path $OutDir 'lib\bin.js') '--version'
  if ($LASTEXITCODE -ne 0) { throw 'bin.js --version 运行失败。' }
  Say ("    bin.js --version -> {0}" -f $v) 'Green'
}
$size = (Get-ChildItem -LiteralPath $OutDir -Recurse -Force -File | Measure-Object Length -Sum).Sum / 1MB
Say ''
Say ("部署目录就绪：{0}" -f $OutDir) 'Green'
Say ("总体积：{0:N1} MB（对比旧方案 tar 874MB）" -f $size) 'Green'
Say ''
Say '下一步：打包时把它当引擎传进去：' 'White'
Say ("  powershell -ExecutionPolicy Bypass -File build-package.ps1 -EngineRoot `"$OutDir`"") 'White'
