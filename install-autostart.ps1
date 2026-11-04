<#
    Adds this installation to the current user's login startup.
    .\install-autostart.ps1 -NoStart
    .\install-autostart.ps1 -Remove
    -Remove only removes this installation's shortcut; node rpc.js --stop stops it.
#>
param([switch]$Remove, [switch]$NoStart)

$ErrorActionPreference = 'Stop'
$appDirectory = [IO.Path]::GetFullPath($PSScriptRoot)
$launcher = Join-Path $appDirectory 'start.vbs'
$scriptHost = Join-Path $env:WINDIR 'System32\wscript.exe'
$startupDirectory = [Environment]::GetFolderPath('Startup')
$linkPath = Join-Path $startupDirectory 'Codex and Claude RPC.lnk'
$arguments = "`"$launcher`""
$shell = New-Object -ComObject WScript.Shell

if (Test-Path -LiteralPath $linkPath) {
    $existingLink = $shell.CreateShortcut($linkPath)
    $owned = ($existingLink.TargetPath -eq $scriptHost -and $existingLink.Arguments -eq $arguments) -or
        $existingLink.TargetPath -eq $launcher
    if (-not $owned) { throw 'the startup shortcut points to another installation; remove it from that installation first' }
}
if ($Remove) {
    if (Test-Path -LiteralPath $linkPath) {
        Remove-Item -LiteralPath $linkPath
        Write-Host 'removed this app from login startup'
    } else { Write-Host 'this app has no login startup shortcut' }
    return
}
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "missing launcher: $launcher" }
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCommand) { throw 'node.js 20 or newer is required' }
& $nodeCommand.Source (Join-Path $appDirectory 'scripts\setup.js') --check
if ($LASTEXITCODE -ne 0) { throw 'run node scripts/setup.js before enabling login startup' }
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = $scriptHost
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $appDirectory
$shortcut.Description = 'codex and claude activity for discord'
$shortcut.WindowStyle = 7
$shortcut.Save()
Write-Host 'added this app to login startup'
if (-not $NoStart) {
    Start-Process -FilePath $scriptHost -ArgumentList $arguments -WorkingDirectory $appDirectory -WindowStyle Hidden
    Write-Host 'started in the background'
}
