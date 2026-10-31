<#
    One-line installer for Clawd, the Claude -> Discord Rich Presence.

    Install or update (paste into PowerShell):
        irm https://raw.githubusercontent.com/telljoe/claude-discord-rpc-dist/main/install.ps1 | iex

    Uninstall:
        powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\ClaudeDiscordRPC\install.ps1" -Uninstall

    What it does, all inside your own user account (no admin):
      - checks for Node.js 18+ (offers to install it with winget)
      - downloads the latest code to %LOCALAPPDATA%\ClaudeDiscordRPC
        (an update keeps your config.json)
      - adds a Startup shortcut so it runs at login, then starts it now
      - from then on it updates itself from GitHub (autoUpdate in config.json)
#>
param(
    [switch]$Uninstall,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'ClaudeDiscordRPC'),
    [switch]$NoAutostart
)

$ErrorActionPreference = 'Stop'
$Repo     = 'telljoe/claude-discord-rpc-dist'
$Branch   = 'main'
$LinkPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Discord RPC.lnk'

function Say($msg, $color = 'Gray') { Write-Host "  $msg" -ForegroundColor $color }

function Stop-Daemon {
    $rpc = Join-Path $InstallDir 'rpc.js'
    if ((Test-Path $rpc) -and (Get-Command node -ErrorAction SilentlyContinue)) {
        & node $rpc --stop | Out-Null
        Start-Sleep -Milliseconds 500
    }
}

Write-Host ''
Write-Host '  Clawd - Claude Rich Presence for Discord' -ForegroundColor DarkYellow
Write-Host ''

# ---------------------------------------------------------------- uninstall

if ($Uninstall) {
    Stop-Daemon
    # Only remove the shortcut if it launches *this* install, not another copy.
    if (Test-Path $LinkPath) {
        $target = (New-Object -ComObject WScript.Shell).CreateShortcut($LinkPath).TargetPath
        if ($target -and $target.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item $LinkPath -Force
            Say 'Removed the Startup shortcut.'
        }
    }
    if (Test-Path $InstallDir) {
        # The script may be running from inside the folder; delete it after we exit.
        Start-Process cmd -WindowStyle Hidden -ArgumentList "/c timeout /t 2 >nul & rmdir /s /q `"$InstallDir`""
        Say "Removed $InstallDir"
    }
    Say 'Uninstalled. Your Discord status clears within a few seconds.' Green
    return
}

# ---------------------------------------------------------------- node

function Get-NodeMajor {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return 0 }
    $v = (& node -v) -replace '^v', ''
    return [int]($v.Split('.')[0])
}

if ((Get-NodeMajor) -lt 18) {
    Say 'Node.js 18 or newer is required and was not found.' Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        $ans = Read-Host '  Install Node.js LTS now with winget? [Y/n]'
        if ($ans -match '^(n|no)$') { Say 'Install Node.js from https://nodejs.org and run this again.'; return }
        winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
        # Pick up the new PATH without opening a new terminal.
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [Environment]::GetEnvironmentVariable('Path', 'User')
        if ((Get-NodeMajor) -lt 18) { Say 'Node.js still not found. Open a new terminal and run this again.' Red; return }
    } else {
        Say 'Install Node.js LTS from https://nodejs.org, then run this again.' Red
        return
    }
}
Say "Node.js $(& node -v) found."

# ---------------------------------------------------------------- download

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("clawd-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zip = Join-Path $tmp 'src.zip'
    Say "Downloading $Repo..."
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest "https://github.com/$Repo/archive/refs/heads/$Branch.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $tmp
    $src = Get-ChildItem $tmp -Directory | Select-Object -First 1

    $updating = Test-Path (Join-Path $InstallDir 'rpc.js')
    if ($updating) { Stop-Daemon }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    # Copy everything over; config.json and logs aren't in the repo, so yours survive.
    Copy-Item (Join-Path $src.FullName '*') $InstallDir -Recurse -Force
    Say $(if ($updating) { "Updated $InstallDir" } else { "Installed to $InstallDir" })
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- privacy (first install only)

$userConfig = Join-Path $InstallDir 'config.json'
if (-not (Test-Path $userConfig)) {
    Write-Host ''
    Say 'What should your Discord status show?'
    Say '  1  full     session title + what Claude is doing ("Editing app.js")'
    Say '  2  project  folder name + a generic verb ("Writing code")'
    Say '  3  minimal  just "Working with Claude"'
    $pick = Read-Host '  Choose 1-3 [1]'
    $privacy = @{ '2' = 'project'; '3' = 'minimal' }[$pick]
    if (-not $privacy) { $privacy = 'full' }
    # Only overrides go here; everything else comes from config.example.json.
    "{`n  `"privacy`": `"$privacy`"`n}`n" | Set-Content -Path $userConfig -Encoding ASCII
    Say "Privacy: $privacy (change it any time in config.json)"
}

# ---------------------------------------------------------------- autostart + start

$vbs = Join-Path $InstallDir 'start.vbs'
if (-not $NoAutostart) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($LinkPath)
    $link.TargetPath = $vbs
    $link.WorkingDirectory = $InstallDir
    $link.Description = 'Claude -> Discord Rich Presence'
    $link.Save()
    Say 'Starts automatically at login.'
}
Start-Process wscript.exe -ArgumentList "`"$vbs`""
Start-Sleep -Seconds 3

$log = Join-Path $InstallDir 'rpc.log'
$tail = if (Test-Path $log) { Get-Content $log -Tail 3 } else { @() }
Write-Host ''
if ($tail -match 'connected to Discord') {
    Say 'Running and connected to Discord.' Green
} elseif ($tail -match 'already running') {
    Say 'Another copy is already running from a different folder, so this one stepped aside.' Yellow
    Say 'Stop the other one (node <its folder>\rpc.js --stop), then run start.vbs here.' Yellow
} else {
    Say 'Running. If Discord is closed it will connect when Discord opens.' Green
}
Write-Host ''
Say 'Make sure Discord > Settings > Activity Privacy > "Share your detected activities" is on.'
Say "Preview what it shows:  node `"$InstallDir\rpc.js`" --status"
Say "Uninstall:              powershell -ExecutionPolicy Bypass -File `"$InstallDir\install.ps1`" -Uninstall"
Write-Host ''
