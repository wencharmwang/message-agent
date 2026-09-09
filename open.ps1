$ErrorActionPreference='Stop'
$taskLog=Join-Path $PSScriptRoot 'harness.log'
$taskMatch=Get-Content -LiteralPath $taskLog | Select-String -Pattern '^dsh web: (http://127\.0\.0\.1:\d+/\?token=\S+)$' | Select-Object -Last 1
if(-not $taskMatch){throw 'Harness is not started. Start the Messaging Agent scheduled task first.'}
try {Start-Process -FilePath $taskMatch.Matches.Groups[1].Value -WindowStyle Hidden}
catch {throw 'Could not open the Harness browser.'}
