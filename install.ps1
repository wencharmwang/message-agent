$ErrorActionPreference='Stop'
$taskTarget='C:\Users\Wencharm\Documents\projects\message-agent'
$taskRuntime='C:\Users\Wencharm\Documents\projects\messaging-runtime'
if(Test-Path -LiteralPath (Join-Path $taskTarget 'launch.py')) {
    $taskExisting=Get-ScheduledTask -TaskName 'Messaging Agent' -ErrorAction SilentlyContinue
    if($taskExisting) {
        if($taskExisting.Actions.WorkingDirectory -ne $taskTarget){throw 'Unexpected task owner'}
        Stop-ScheduledTask -TaskName 'Messaging Agent'
    }
}
$taskOld=Get-ScheduledTask -TaskName 'Messaging Auto Reply' -ErrorAction SilentlyContinue
if($taskOld){
    if($taskOld.Actions.WorkingDirectory -ne $taskRuntime){throw 'Unexpected legacy worker owner'}
    Stop-ScheduledTask -TaskName 'Messaging Auto Reply'
    Disable-ScheduledTask -TaskName 'Messaging Auto Reply' | Out-Null
}
$taskDeadline=(Get-Date).AddSeconds(20)
while(Get-NetTCPConnection -LocalPort 8767 -State Listen -ErrorAction SilentlyContinue){
    if((Get-Date) -gt $taskDeadline){throw 'Previous worker has not stopped'}
    Start-Sleep -Milliseconds 250
}
New-Item -ItemType Directory -Path $taskTarget,(Join-Path $taskTarget 'workspace') -Force | Out-Null
foreach($taskName in @('agent_worker','plugin','presets','launch.py','config.json','web.patch.yml','README.md','open.ps1')){
    if([IO.Path]::GetFullPath($PSScriptRoot) -ne [IO.Path]::GetFullPath($taskTarget)) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $taskName) -Destination $taskTarget -Recurse -Force
    }
}
$taskPython=Join-Path $taskRuntime 'runtime\python\pythonw.exe'
$taskAction=New-ScheduledTaskAction -Execute $taskPython -Argument ('"'+(Join-Path $taskTarget 'launch.py')+'"') -WorkingDirectory $taskTarget
$taskUser=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskPrincipal=New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$taskTrigger=New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$taskSettings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Messaging Agent' -Action $taskAction -Principal $taskPrincipal -Trigger $taskTrigger -Settings $taskSettings -Description 'DeepSeek Harness Web and message event worker above messaging-runtime.' -Force | Out-Null
Start-ScheduledTask -TaskName 'Messaging Agent'
Write-Output 'Messaging Agent installed and starting at http://127.0.0.1:3080'
