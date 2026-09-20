<#
  装一个本地模型（Ollama），并接进消息助手 —— 不想用云端 API key 就走这条路。

  它会做四件事：
    1) 没装 Ollama 就装（优先 winget，其次官方安装包）
    2) 下载一个模型（默认 qwen2.5:7b，约 4.7 GB，只下一次）
    3) 把模型写进引擎的配置（只增不删：你已有的本地模型会留着）
    4) 重启消息助手，让新配置生效

  用法（右键本文件 → 使用 PowerShell 运行；想换模型就加参数）：
      powershell -ExecutionPolicy Bypass -File install-local-model.ps1
      powershell -ExecutionPolicy Bypass -File install-local-model.ps1 -Model qwen2.5:3b

  跑完之后：打开消息助手 → 设置 → 模型 → 「默认模型」里选「本地模型」。
#>
param(
  [string]$Model = 'qwen2.5:7b',
  [string]$Name = '本地模型',
  [int]$ContextWindow = 32768,
  [int]$MaxTokens = 2048,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
$installDir = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $installDir 'config.json'))) {
  # 允许在开发仓库的 packaging\ 目录下直接跑
  $root = Split-Path $installDir -Parent
  if (Test-Path -LiteralPath (Join-Path $root 'config.json')) { $installDir = $root }
}
$python = Join-Path $installDir 'runtimes\python\python.exe'
if (-not (Test-Path -LiteralPath $python)) { $python = Join-Path $installDir 'app\runtimes\python\python.exe' }
if (-not (Test-Path -LiteralPath $python)) { $python = 'python' }

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

Say ''
Say '装一个本地模型（不需要联网调用云端）' 'Cyan'
Say "  模型：$Model（下载可能需要一会儿，只下一次）" 'White'
Say ''

# --- 1. Ollama -------------------------------------------------------------
$ollama = (Get-Command ollama -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $ollama) {
  $guess = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
  if (Test-Path -LiteralPath $guess) { $ollama = $guess }
}
if (-not $ollama) {
  Say '没有找到 Ollama，先装它。' 'Yellow'
  $winget = (Get-Command winget -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if ($winget) {
    Say '  用 winget 安装 Ollama…' 'DarkGray'
    & $winget install -e --id Ollama.Ollama --accept-package-agreements --accept-source-agreements
    Start-Sleep 5
    $guess = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path -LiteralPath $guess) { $ollama = $guess }
  } else {
    Say '  这台电脑没有 winget，改为下载官方安装包（会弹出安装界面，跟着点下一步即可）。' 'Yellow'
    $setup = Join-Path $env:TEMP 'OllamaSetup.exe'
    if (-not (Test-Path -LiteralPath $setup)) {
      Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile $setup -UseBasicParsing
    }
    Start-Process -FilePath $setup -Wait
    $guess = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path -LiteralPath $guess) { $ollama = $guess }
  }
}
if (-not $ollama) { Say 'Ollama 没有装上。装好之后再运行一次本脚本即可。' 'Red'; exit 1 }
Say "  Ollama：$ollama" 'Green'

# --- 2. 模型 ---------------------------------------------------------------
Say "  下载模型 $Model …" 'DarkGray'
& $ollama pull $Model
if ($LASTEXITCODE -ne 0) { Say "下载 $Model 失败（网络或磁盘空间？）。换个更小的试试：-Model qwen2.5:3b" 'Red'; exit 1 }
Say '  模型就绪' 'Green'

# --- 3. 写进引擎配置（只增不删）--------------------------------------------
$configPath = Join-Path $installDir 'config.json'
$harnessHome = ''
if (Test-Path -LiteralPath $configPath) {
  $harnessHome = (Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json).harness_home
}
if (-not $harnessHome) { $harnessHome = Join-Path $installDir '.harness' }
$settings = Join-Path $harnessHome 'settings.yaml'
$patcher = Join-Path $installDir 'set_local_provider.py'
if (-not (Test-Path -LiteralPath $patcher)) { $patcher = Join-Path $installDir 'app\set_local_provider.py' }
if (-not (Test-Path -LiteralPath $patcher)) { Say '找不到 set_local_provider.py，安装可能不完整。' 'Red'; exit 1 }

& $python $patcher --settings $settings --model $Model --name $Name `
  --context-window $ContextWindow --max-tokens $MaxTokens
if ($LASTEXITCODE -ne 0) { Say '写配置失败。' 'Red'; exit 1 }

# --- 4. 让本地 provider 的凭据引用有值 --------------------------------------
# 引擎按 apiKeyEnv 取凭据；Ollama 本身不校验，但引用缺失会让它报错。
# 走和安装程序同一条路（Windows 密钥保护），不往配置文件里写明文。
$credDir = Join-Path (Split-Path $configPath -Parent) 'data\credentials'
if (Test-Path -LiteralPath $configPath) {
  $configured = (Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json).credentials_dir
  if ($configured) { $credDir = $configured }
}
New-Item -ItemType Directory -Force -Path $credDir | Out-Null
$env:MA_CRED_DIR = $credDir
& $python -c @"
import os, sys
sys.path.insert(0, r'$installDir')
sys.path.insert(0, r'$(Join-Path $installDir 'app')')
from agent_worker import secrets_store
target = os.path.join(os.environ['MA_CRED_DIR'], 'model-cloud.dat')
current = secrets_store.read_secret(target) or {}
current['OLLAMA_LOCAL_API_KEY'] = 'ollama-local'
secrets_store.write_secret(target, current)
print('  凭据已写入密钥保护存储')
"@
$env:MA_CRED_DIR = $null

# --- 5. 重启生效 -----------------------------------------------------------
Say '  本地模型已接好' 'Green'
if ($NoRestart) {
  Say '  请自己重启消息助手（运行 restart.ps1），然后到「设置 → 模型」选「本地模型」。' 'Yellow'
} else {
  $restart = Join-Path $installDir 'restart.ps1'
  if (Test-Path -LiteralPath $restart) {
    & $restart
    Say '  已重启。打开消息助手 → 设置 → 模型 → 默认模型，选「本地模型」。' 'Green'
  } else {
    Say '  请自己重启消息助手，然后到「设置 → 模型」选「本地模型」。' 'Yellow'
  }
}
exit 0
