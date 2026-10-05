# SPDX-License-Identifier: MIT
#
# confeature CLI installer (Windows x64) — distribution slice #657 / spec 183.
#
# Downloads the Windows binary for this host, verifies its SHA-256 against the
# release's SHA256SUMS manifest, and installs it under %LOCALAPPDATA%\Programs\
# confeature. Designed for `irm <url>/install.ps1 | iex`.
#
# It is FAIL-CLOSED (FR-006): an unsupported architecture, download failure,
# checksum mismatch, or unwritable install dir aborts WITHOUT installing, with
# a clear message. Transport is HTTPS-only (FR-007); no secret is embedded and
# no remote content is executed beyond the verified binary. Dependency-free
# beyond Windows PowerShell 5+ (Invoke-WebRequest, Get-FileHash).
#
# Usage:
#   irm https://cli.confeature.io/install.ps1 | iex
#   # pin a version:
#   & ([scriptblock]::Create((irm https://cli.confeature.io/install.ps1))) -Version 0.1.0
#
# Releases are served from https://cli.confeature.io (Cloudflare R2, #801) —
# a permanent contract: `v<version>/<asset>` is immutable, and `latest` holds
# the current version as exactly `X.Y.Z`.

[CmdletBinding()]
param(
  # Pin a specific release; default (empty) installs the latest.
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
# Fail closed on any HTTP error and force TLS 1.2+ (older Windows defaults to
# SSL3/TLS1.0, which the host rejects).
[Net.ServicePointManager]::SecurityProtocol = `
  [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$BaseUrl = "https://cli.confeature.io"
$Binary = "confeature.exe"

# Fail closed: print to stderr and throw a terminating error. Under
# $ErrorActionPreference = "Stop" this unwinds through any `finally` (so the
# temp dir is still cleaned up) and exits the script non-zero.
function Abort([string]$Message) {
  [Console]::Error.WriteLine("install.ps1: $Message")
  throw $Message
}

# ---- the ONE version check, for -Version and for the fetched `latest` ------
# A version is interpolated into the release URL and logged. The whole value
# must be exactly X.Y.Z of ASCII digits: `\A…\z` (not `^…$`, which in .NET
# accepts a trailing newline), explicit [0-9] (not `\d`, which accepts
# non-ASCII digits), case-sensitive -cmatch (#801, FR-008).
function Test-Version([string]$Value) {
  return $Value -cmatch '\A[0-9]+\.[0-9]+\.[0-9]+\z'
}

if ($Version -and -not (Test-Version $Version)) {
  Abort "invalid -Version '$Version' (expected X.Y.Z, e.g. 0.1.0)"
}

# ---- platform detection ----------------------------------------------------
# Only Windows x64 ships a binary. Anything else aborts with a pointer to the
# manual-download list (FR-006).
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne "AMD64") {
  Abort @"
unsupported architecture '$arch'. Only Windows x64 (AMD64) is published.
Download a binary manually from $BaseUrl/v<version>/ (the current version is at $BaseUrl/latest).
"@
}
$asset = "confeature-x86_64-pc-windows-msvc.exe"

# ---- resolve the version: pinned, or the published `latest` ----------------
# No fallback: an unreadable or malformed pointer aborts rather than guessing.
# Read as raw text (Invoke-WebRequest .Content), not `irm`, which may parse it.
if (-not $Version) {
  try {
    $latest = (Invoke-WebRequest -Uri "$BaseUrl/latest" -UseBasicParsing).Content
  }
  catch {
    Abort "failed to read the latest version from $BaseUrl/latest - check your network. ($($_.Exception.Message))"
  }
  if ($latest -is [byte[]]) { $latest = [System.Text.Encoding]::ASCII.GetString($latest) }
  $Version = ([string]$latest).Trim()
  if (-not (Test-Version $Version)) {
    Abort "the published latest version is not X.Y.Z - refusing to guess."
  }
}
$base = "$BaseUrl/v$Version"

# ---- download into an isolated temp dir ------------------------------------
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("confeature-install-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
  $assetPath = Join-Path $work $asset
  $sumsPath = Join-Path $work "SHA256SUMS"

  Write-Host "==> downloading $asset ($Version) ..."
  try {
    Invoke-WebRequest -Uri "$base/$asset" -OutFile $assetPath -UseBasicParsing
    Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sumsPath -UseBasicParsing
  }
  catch {
    Abort "download failed from $base - check the version and your network. ($($_.Exception.Message))"
  }

  # ---- verify the checksum (fail closed) -----------------------------------
  # SHA256SUMS lines are `<hexdigest>  <asset>` (sha256sum format). Find ours.
  $expected = $null
  foreach ($line in Get-Content $sumsPath) {
    $parts = $line -split '\s+', 2
    if ($parts.Count -eq 2) {
      $name = $parts[1].TrimStart('*').Trim()
      if ($name -eq $asset) { $expected = $parts[0].Trim().ToLower(); break }
    }
  }
  if (-not $expected) {
    Abort "no checksum for $asset in SHA256SUMS - refusing to install."
  }

  $actual = (Get-FileHash -Algorithm SHA256 -Path $assetPath).Hash.ToLower()
  if ($expected -ne $actual) {
    Abort @"
checksum mismatch for ${asset}:
  expected $expected
  actual   $actual
Refusing to install a tampered or corrupt download.
"@
  }
  Write-Host "==> checksum verified ($actual)"

  # ---- install -------------------------------------------------------------
  $installDir = Join-Path $env:LOCALAPPDATA "Programs\confeature"
  try {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  }
  catch {
    Abort "cannot create the install directory '$installDir'. ($($_.Exception.Message))"
  }

  $dest = Join-Path $installDir $Binary
  Move-Item -Path $assetPath -Destination $dest -Force
  Write-Host "==> installed $Binary to $dest"

  # Put the dir on the USER PATH idempotently (#660). We read the USER-scope PATH
  # from the registry and append `$installDir` ONLY when it is absent, then write
  # the USER scope back — so re-running the installer never duplicates the entry.
  # NB: we deliberately do NOT bake the expanded session `$env:PATH` (what
  # `setx PATH "$installDir;$env:PATH"` did): that copied every system entry into
  # the user PATH and grew it on every re-run. SetEnvironmentVariable on the User
  # target also dodges setx's 1024-char truncation.
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $onPath = $userPath -and ($userPath -split ';' | Where-Object { $_.TrimEnd('\') -eq $installDir.TrimEnd('\') })
  if (-not $onPath) {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $installDir } else { "$($userPath.TrimEnd(';'));$installDir" }
    try {
      [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
      Write-Host "==> added $installDir to your user PATH (restart your shell to pick it up)."
    }
    catch {
      Write-Host "note: couldn't update your PATH automatically. Add $installDir manually."
    }
  }
  Write-Host "==> run 'confeature --version' to confirm."
}
finally {
  Remove-Item -Path $work -Recurse -Force -ErrorAction SilentlyContinue
}
