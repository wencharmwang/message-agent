<#
  装"语音转文字"（可选，用户自己决定）。

  为什么要单独一步、而不是塞进安装包：
    SILK 解码器只有 75 KB，已经随包走了，装上就能把语音变成声音波形；
    但"听出说的是什么"要一个几百 MB 的模型（faster-whisper small ≈ 470 MB）+ CTranslate2。
    硬塞进包会让所有人为一个可能不用的功能买单，而且聊天语音要不要送去识别，
    本来就该由用户点这个头。

  做完这三件事：
    1) 给自带的 Python 装上 pip（embeddable 版本不自带）
    2) 把 faster-whisper 装到一个独立目录（不污染程序本体）
    3) 下载识别模型，然后把设置里的开关打开

  用法（右键 → 使用 PowerShell 运行）：
      powershell -ExecutionPolicy Bypass -File install-voice.ps1
      powershell -ExecutionPolicy Bypass -File install-voice.ps1 -Model base   # 更小更快，但会吐繁体，不建议
#>
param(
  [string]$Model = 'small',
  [switch]$NoEnable
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

Say ''
Say '装"语音转文字"（可选）' 'Cyan'
Say '  语音解码器已经随包提供（75 KB）；这一步装的是"听懂内容"的模型。' 'White'
Say "  模型：$Model（small ≈ 470 MB，只下一次）" 'White'
Say ''

# ---- 定位程序目录与自带 Python -------------------------------------------
$installDir = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $installDir 'config.json'))) {
  $root = Split-Path $installDir -Parent
  if (Test-Path -LiteralPath (Join-Path $root 'config.json')) { $installDir = $root }
}
$config = Get-Content -LiteralPath (Join-Path $installDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$dataDir = Split-Path $config.database -Parent
$python = Join-Path $installDir 'runtimes\python\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw "找不到自带的 Python：$python" }

$voiceDir = Join-Path $dataDir 'voice'
$libDir = Join-Path $voiceDir 'lib'
New-Item -ItemType Directory -Force -Path $libDir | Out-Null
Say "  程序目录：$installDir"
Say "  数据目录：$dataDir"

# ---- 1) 给自带 Python 装 pip ----------------------------------------------
Say '--- 准备 pip ---' 'DarkGray'
$hasPip = $false
try { & $python -m pip --version *> $null; $hasPip = ($LASTEXITCODE -eq 0) } catch { $hasPip = $false }
if (-not $hasPip) {
  $getPip = Join-Path $voiceDir 'get-pip.py'
  if (-not (Test-Path -LiteralPath $getPip)) {
    Say '  下载 get-pip.py…' 'DarkGray'
    Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getPip -UseBasicParsing
  }
  & $python $getPip --no-warn-script-location *>> (Join-Path $voiceDir 'install.log')
  try { & $python -m pip --version *> $null; $hasPip = ($LASTEXITCODE -eq 0) } catch { $hasPip = $false }
}
if (-not $hasPip) { Say '  pip 没有装上，这一步失败了（看 voice\install.log）。' 'Red'; exit 1 }
Say '  pip 就绪' 'Green'

# ---- 2) 装 faster-whisper 到独立目录 --------------------------------------
Say '--- 安装识别引擎（faster-whisper）---' 'DarkGray'
& $python -m pip install --disable-pip-version-check --no-warn-script-location `
  --target $libDir faster-whisper *>> (Join-Path $voiceDir 'install.log')
if ($LASTEXITCODE -ne 0) { Say '  安装失败（看 voice\install.log）。' 'Red'; exit 1 }
Say '  识别引擎装好了' 'Green'

# ---- 3) 下载模型（第一次会下几百 MB）--------------------------------------
Say "--- 下载模型 $Model（可能要几分钟）---" 'DarkGray'
$env:PYTHONPATH = $libDir
$env:MA_MODEL = $Model
& $python -c @"
import os
from faster_whisper import WhisperModel
WhisperModel(os.environ['MA_MODEL'], device='cpu', compute_type='int8')
print('模型已就绪')
"@
if ($LASTEXITCODE -ne 0) { Say '  模型下载失败（网络？），可以再运行一次本脚本。' 'Red'; exit 1 }

# ---- 4) 打开开关 ----------------------------------------------------------
if (-not $NoEnable) {
  $prefPath = Join-Path $dataDir 'voice.json'
  $pref = @{ enabled = $true; model = $Model } | ConvertTo-Json
  [IO.File]::WriteAllText($prefPath, $pref, [Text.UTF8Encoding]::new($false))
  Say '  已打开"语音转文字"开关' 'Green'
}

Say ''
Say '装好了。' 'Green'
Say '  以后对方发语音，助手会先把内容转成文字再处理（在这台电脑上转，不联网）。' 'White'
Say '  不想用了：到「设置 → 语音」里关掉开关即可（模型留着，随时能再开）。' 'White'
exit 0
