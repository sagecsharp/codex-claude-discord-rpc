<#
    Installs this local checkout without downloading or enabling upstream updates.
    .\install.ps1
    .\install.ps1 -InstallDir 'C:\Tools\CodexClaudeRPC' -NoAutostart
    .\install.ps1 -NoAutostart -NoStart -SkipSetup
    Remove login startup with the installed install-autostart.ps1 -Remove.
#>
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'CodexClaudeRPC'),
    [switch]$NoAutostart,
    [switch]$NoStart,
    [switch]$SkipSetup
)

$ErrorActionPreference = 'Stop'
$sourceDirectory = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\', '/')
$destinationDirectory = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\', '/')
$markerName = '.codex-claude-rpc-install.json'
$markerPath = Join-Path $destinationDirectory $markerName
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCommand) { throw 'install node.js 20 or newer, then run this installer again' }
$nodeVersion = & $nodeCommand.Source -p 'parseInt(process.versions.node)'
if ($LASTEXITCODE -ne 0 -or [int]$nodeVersion -lt 20) { throw 'node.js 20 or newer is required' }
if ($destinationDirectory -eq $sourceDirectory) { throw 'choose an install folder separate from this source checkout' }
if ($destinationDirectory -eq [IO.Path]::GetPathRoot($destinationDirectory).TrimEnd('\', '/') -or
    $destinationDirectory -eq [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\', '/') -or
    $destinationDirectory -eq [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\', '/')) {
    throw 'choose a dedicated install folder'
}
if (Test-Path -LiteralPath $destinationDirectory) {
    $destinationItem = Get-Item -LiteralPath $destinationDirectory
    if (-not $destinationItem.PSIsContainer -or ($destinationItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'the install target must be a regular directory'
    }
    if ((Get-ChildItem -LiteralPath $destinationDirectory -Force | Select-Object -First 1) -and -not (Test-Path -LiteralPath $markerPath)) {
        throw 'the install folder is not empty and is not owned by this app; choose another folder'
    }
    if (Test-Path -LiteralPath $markerPath) {
        $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
        if ($marker.app -ne 'codex-claude-rpc') { throw 'the install marker belongs to another app' }
        $installedEntry = Join-Path $destinationDirectory 'rpc.js'
        if (Test-Path -LiteralPath $installedEntry) { & $nodeCommand.Source $installedEntry --stop }
    }
} else {
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
}

$relativeFiles = @('rpc.js', 'start.vbs', 'package.json', 'package-lock.json', 'README.md', 'PRICING.md', 'LICENSE', 'NOTICE', 'VERSION', 'config.example.json', 'install.ps1', 'install-autostart.ps1', 'preview.html')
foreach ($directory in @('lib', 'assets', 'scripts')) {
    $folder = Join-Path $sourceDirectory $directory
    if (Test-Path -LiteralPath $folder) {
        foreach ($file in Get-ChildItem -LiteralPath $folder -File -Recurse) {
            if (-not ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                $relativeFiles += $file.FullName.Substring($sourceDirectory.Length + 1)
            }
        }
    }
}
$installedFiles = @()
foreach ($relativeFile in $relativeFiles) {
    $sourceFile = Join-Path $sourceDirectory $relativeFile
    if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { continue }
    $destinationFile = Join-Path $destinationDirectory $relativeFile
    New-Item -ItemType Directory -Path (Split-Path -Parent $destinationFile) -Force | Out-Null
    Copy-Item -LiteralPath $sourceFile -Destination $destinationFile -Force
    $installedFiles += $relativeFile
}
$configPath = Join-Path $destinationDirectory 'config.json'
$sourceConfigPath = Join-Path $sourceDirectory 'config.json'
if (-not (Test-Path -LiteralPath $configPath) -and (Test-Path -LiteralPath $sourceConfigPath -PathType Leaf)) {
    Copy-Item -LiteralPath $sourceConfigPath -Destination $configPath
}
@{ app = 'codex-claude-rpc'; files = $installedFiles; installedAt = [DateTime]::UtcNow.ToString('o') } |
    ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $markerPath -Encoding UTF8

$setupScript = Join-Path $destinationDirectory 'scripts\setup.js'
& $nodeCommand.Source $setupScript --check
$configurationState = $LASTEXITCODE
if ($configurationState -eq 1) { throw 'the installed configuration is invalid; fix it before starting the app' }
if (-not $SkipSetup -and $configurationState -eq 2) {
    & $nodeCommand.Source $setupScript
    if ($LASTEXITCODE -ne 0) { throw 'setup did not finish; run node scripts/setup.js from the install folder' }
    & $nodeCommand.Source $setupScript --check
    $configurationState = $LASTEXITCODE
}
$configured = $configurationState -eq 0
if (-not $NoAutostart -and $configured) {
    & (Join-Path $destinationDirectory 'install-autostart.ps1') -NoStart
}
if (-not $NoStart -and $configured) {
    $launcher = Join-Path $destinationDirectory 'start.vbs'
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList "`"$launcher`"" -WorkingDirectory $destinationDirectory -WindowStyle Hidden
}
Write-Host "installed in $destinationDirectory"
if (-not $configured) { Write-Host "next: run node `"$(Join-Path $destinationDirectory 'scripts\setup.js')`"" }
