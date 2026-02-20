param(
    [string]$InstallDir = "$HOME\TITAN",
    [string]$RepoUrl = "https://github.com/Djtony707/TITAN.git",
    [switch]$Debug,
    [switch]$SkipOnboard,
    [switch]$InstallDaemon,
    [switch]$NoLink,
    [string]$BinDir = "$env:LOCALAPPDATA\Programs\TITAN\bin"
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
    Write-Host "==> $Message"
}

function Has-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Ensure-Git {
    if (Has-Command "git") { return }
    if (Has-Command "winget") {
        Write-Step "Git not found. Installing via winget..."
        winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
        if (Has-Command "git") { return }
    }
    throw "Git is required. Install Git and re-run this script."
}

function Ensure-Rust {
    if ((Has-Command "cargo") -and (Has-Command "rustc")) { return }

    if (Has-Command "winget") {
        Write-Step "Rust toolchain not found. Installing rustup via winget..."
        winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
    } else {
        throw "Rust is required. Install from https://rustup.rs and re-run this script."
    }

    $cargoBin = Join-Path $HOME ".cargo\bin"
    if (Test-Path $cargoBin) {
        if (-not ($env:PATH -split ';' | Where-Object { $_ -eq $cargoBin })) {
            $env:PATH = "$cargoBin;$env:PATH"
        }
    }

    if (-not ((Has-Command "cargo") -and (Has-Command "rustc"))) {
        throw "Rust installation did not complete in this session. Open a new PowerShell and run again."
    }
}

function Ensure-UserPath([string]$PathToAdd) {
    $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ([string]::IsNullOrWhiteSpace($currentUserPath)) {
        [Environment]::SetEnvironmentVariable("Path", $PathToAdd, "User")
        return
    }

    $paths = $currentUserPath -split ';'
    if ($paths -contains $PathToAdd) { return }

    [Environment]::SetEnvironmentVariable("Path", "$currentUserPath;$PathToAdd", "User")
}

Write-Step "TITAN installer starting"
Write-Step "repo: $RepoUrl"
Write-Step "dir:  $InstallDir"

Ensure-Git
Ensure-Rust

if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Step "Existing TITAN checkout found. Updating..."
    git -C $InstallDir fetch --all --tags
    git -C $InstallDir pull --ff-only
} else {
    Write-Step "Cloning TITAN..."
    New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir -Parent) | Out-Null
    git clone $RepoUrl $InstallDir
}

Set-Location $InstallDir

$profileName = if ($Debug) { "debug" } else { "release" }
Write-Step "Building TITAN ($profileName)..."
if ($Debug) {
    cargo build
    $TitanExe = Join-Path $InstallDir "target\debug\titan.exe"
} else {
    cargo build --release
    $TitanExe = Join-Path $InstallDir "target\release\titan.exe"
}

if (-not (Test-Path $TitanExe)) {
    throw "Build completed but titan.exe not found at $TitanExe"
}

Write-Step "Build complete"
Write-Step "binary: $TitanExe"

$TitanCmd = $TitanExe
if (-not $NoLink) {
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $TargetExe = Join-Path $BinDir "titan.exe"
    Copy-Item -Force -Path $TitanExe -Destination $TargetExe
    Ensure-UserPath $BinDir
    if (-not ($env:PATH -split ';' | Where-Object { $_ -eq $BinDir })) {
        $env:PATH = "$BinDir;$env:PATH"
    }
    Write-Step "Installed titan command at $TargetExe"
    $TitanCmd = "titan"
}

if (-not $SkipOnboard) {
    Write-Step "Launching setup wizard..."
    if ($InstallDaemon) {
        & $TitanCmd setup --install-daemon
    } else {
        & $TitanCmd setup
    }
} else {
    Write-Step "Onboarding skipped by flag."
    if ($InstallDaemon) {
        Write-Host "Run this next: $TitanCmd setup --install-daemon"
    } else {
        Write-Host "Run this next: $TitanCmd setup"
    }
}

Write-Step "Quick validation commands"
Write-Host "$TitanCmd doctor"
Write-Host "$TitanCmd model show"
Write-Host "$TitanCmd comm list"
