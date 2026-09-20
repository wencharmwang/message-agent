<#
  【需要你确认】读取微信数据库密钥。

  为什么要有这个脚本：助手要读微信的消息，就必须拿到微信数据库的密钥；而那个密钥只在
  微信进程的内存里，**读一次内存**是这套流程里最敏感的动作（杀毒软件会关注，也要求微信
  正在运行）。所以我们不自动做这件事 —— 只有你运行这个脚本、并看到它问你确认之后，才会读一次。

  读到的密钥会用 Windows 自带的密钥保护（DPAPI）加密保存，磁盘上不留明文。
  日常启动不会再读内存：用的是这份加密保存的密钥。

  什么时候需要运行它：
    * 第一次安装之后；
    * 页面上提示"还没有读到会话、缺密钥"的时候；
    * 换了微信账号，或微信大版本升级之后。

  用法：右键本文件 → 使用 PowerShell 运行
#>
param([switch]$Yes)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
$installDir = $PSScriptRoot
$python = Join-Path $installDir 'runtimes\python\python.exe'
if (-not (Test-Path -LiteralPath $python)) { $python = Join-Path $installDir 'app\runtimes\python\python.exe' }
if (-not (Test-Path -LiteralPath $python)) { Write-Host '找不到自带的 Python 运行时，安装可能不完整。' -ForegroundColor Red; exit 1 }

$keysScript = Join-Path $installDir 'wechat_keys.py'
if (-not (Test-Path -LiteralPath $keysScript)) { $keysScript = Join-Path $installDir 'app\wechat_keys.py' }
if (-not (Test-Path -LiteralPath $keysScript)) { Write-Host '找不到 wechat_keys.py，安装可能不完整。' -ForegroundColor Red; exit 1 }

$config = Get-Content -LiteralPath (Join-Path $installDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
# 让脚本知道凭据放哪（和 launch.py 用同一套约定）
$env:MESSAGE_AGENT_CREDENTIALS = if ($config.credentials_dir) { $config.credentials_dir } else { Join-Path (Split-Path $config.control_token_file -Parent | Split-Path -Parent) 'credentials' }

Write-Host ''
Write-Host '读取微信数据库密钥' -ForegroundColor Cyan
Write-Host '  这一步会：' 
Write-Host '   1) 读一次微信进程的内存，取出数据库密钥（这是唯一需要读内存的动作）'
Write-Host '   2) 用 Windows 密钥保护把密钥加密保存到本机'
Write-Host '   3) 删掉之前留下的明文密钥缓存'
Write-Host ''
Write-Host '  前提：微信正在运行并且已登录。' -ForegroundColor Yellow
Write-Host ''

if (-not $Yes) {
  $answer = Read-Host '确认现在读取吗？输入 YES 继续'
  if ($answer -ne 'YES') { Write-Host '已取消，什么都没有做。' -ForegroundColor Green; exit 0 }
}

& $python $keysScript 'scan'
$code = $LASTEXITCODE
Write-Host ''
if ($code -eq 0) {
  Write-Host '完成。下一步：重启消息助手让它用上新密钥。' -ForegroundColor Green
  $restart = Join-Path $installDir 'restart.ps1'
  if (Test-Path -LiteralPath $restart) {
    if ($Yes -or (Read-Host '现在重启消息助手吗？[Y/n]') -notmatch '^[nN]') { & $restart }
  }
} else {
  Write-Host "没有读到可用的密钥（退出码 $code）。" -ForegroundColor Yellow
  Write-Host '常见原因：微信没登录、微信数据目录不在默认位置、或密钥缓存与当前数据库不匹配。' -ForegroundColor Yellow
}
exit $code
