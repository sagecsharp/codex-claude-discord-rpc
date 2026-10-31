<#
    Adds (or with -Remove, deletes) a Startup shortcut so the presence daemon
    runs at login. No admin rights needed - it only writes to your own
    Startup folder.

        powershell -ExecutionPolicy Bypass -File install-autostart.ps1
        powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$target   = Join-Path $here 'start.vbs'
$startup  = [Environment]::GetFolderPath('Startup')
$linkPath = Join-Path $startup 'Claude Discord RPC.lnk'

if ($Remove) {
    & node (Join-Path $here 'rpc.js') --stop
    if (Test-Path $linkPath) {
        Remove-Item $linkPath -Force
        Write-Host "Removed $linkPath"
    } else {
        Write-Host "Nothing to remove - no shortcut at $linkPath"
    }
    return
}

if (-not (Test-Path $target)) { throw "start.vbs not found next to this script ($target)" }

$shell = New-Object -ComObject WScript.Shell
$link  = $shell.CreateShortcut($linkPath)
$link.TargetPath       = $target
$link.WorkingDirectory = $here
$link.Description      = 'Claude Desktop -> Discord Rich Presence'
$link.Save()

Write-Host "Installed $linkPath"
Write-Host "Starting it now..."
Start-Process -FilePath $target
Write-Host "Running. Logs: $(Join-Path $here 'rpc.log')"
