<#
.SYNOPSIS
  Backs up, verifies or restores the LOCAL DEVELOPMENT database (an embedded PostgreSQL folder) with SHA-256 evidence.
  Written for migration 0018 (see MIGRATION_0018_EXECUTION_RUNBOOK.md). It never runs by itself and changes nothing
  unless you start it. It is for the embedded development database only: never point it at anything else.

.DESCRIPTION
  Mode Backup  (default)  Copies -Source to -Destination, writes <Destination>.sha256.txt (one "HASH  \relative\path" line
                          per file, the same format as the earlier dev-db-backup-before-00NN manifests), then re-reads the COPY
                          and compares every hash. Refuses when the destination or its manifest already exists (never overwrites).
  Mode Verify             Re-hashes -Destination against its manifest. Changes nothing.
  Mode Restore            Puts the backup back as -Source. The current folder is MOVED ASIDE (never deleted) to
                          <Source>.replaced-<timestamp>, and Restore also needs -ConfirmRestore. The backup is verified first.

  Safety rules, all enforced before anything is written:
    * the application must be STOPPED: a running embedded database keeps postmaster.pid in its folder, and a copy of a live
      folder can be inconsistent. If the file is there and you are sure nothing is running (after a crash), pass -AllowStalePid.
    * the source must look like an embedded PostgreSQL data directory (PG_VERSION, base, global).
    * the destination must not be inside the source, and must not already exist.

.EXAMPLE
  powershell -File scripts\backup-dev-db.ps1                       # backup before 0018 to the proposed folder
  powershell -File scripts\backup-dev-db.ps1 -Mode Verify
  powershell -File scripts\backup-dev-db.ps1 -Mode Restore -ConfirmRestore
#>
[CmdletBinding()]
param(
  [ValidateSet('Backup', 'Verify', 'Restore')] [string]$Mode = 'Backup',
  [string]$Source = (Join-Path (Split-Path $PSScriptRoot -Parent) '.data\development'),
  [string]$Destination = 'D:\Audit\Phase1\dev-db-backup-before-0018',
  [switch]$AllowStalePid,
  [switch]$ConfirmRestore
)
$ErrorActionPreference = 'Stop'

function Full([string]$p) { [System.IO.Path]::GetFullPath($p).TrimEnd('\') }
function Fail([string]$m) { throw "backup-dev-db: $m" }

$src = Full $Source
$dst = Full $Destination
$manifest = "$dst.sha256.txt"

function Assert-DataDirectory([string]$dir) {
  foreach ($need in 'PG_VERSION', 'base', 'global') {
    if (-not (Test-Path (Join-Path $dir $need))) { Fail "$dir does not look like an embedded PostgreSQL data directory (missing $need)." }
  }
}
function Assert-Stopped([string]$dir) {
  if ((Test-Path (Join-Path $dir 'postmaster.pid')) -and -not $AllowStalePid) {
    Fail "postmaster.pid exists in $dir, so a server may be using it. Stop the application first (then the file disappears). After a crash, if you are certain nothing runs, repeat with -AllowStalePid."
  }
}
function Hash-Tree([string]$dir) {
  Get-ChildItem -LiteralPath $dir -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
    $h = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    '{0}  {1}' -f $h, $_.FullName.Substring($dir.Length)
  }
}
function Compare-ToManifest([string]$dir, [string]$file) {
  $expected = Get-Content -LiteralPath $file
  $actual = Hash-Tree $dir
  $diff = Compare-Object -ReferenceObject $expected -DifferenceObject $actual
  if ($diff) { $diff | Select-Object -First 10 | Format-Table -AutoSize | Out-String | Write-Host; Fail "VERIFICATION FAILED: $($diff.Count) difference(s) between $dir and $file." }
  "{0} files verified against {1}" -f $expected.Count, $file
}

switch ($Mode) {
  'Backup' {
    Assert-DataDirectory $src
    Assert-Stopped $src
    if ($dst.StartsWith($src + '\', [StringComparison]::OrdinalIgnoreCase)) { Fail 'The destination is inside the source.' }
    if ((Test-Path -LiteralPath $dst) -or (Test-Path -LiteralPath $manifest)) { Fail "Refusing to overwrite: $dst or $manifest already exists. Choose another destination." }
    New-Item -ItemType Directory -Path $dst | Out-Null
    # robocopy exit codes 0-7 are success; 8 and above are failures.
    robocopy $src $dst /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "robocopy failed with exit code $LASTEXITCODE. The partial copy is left at $dst for inspection; nothing in $src was changed." }
    $sourceHashes = Hash-Tree $src
    Set-Content -LiteralPath $manifest -Value $sourceHashes -Encoding ASCII
    Write-Host (Compare-ToManifest $dst $manifest)
    Write-Host "Backup complete: $dst"
    Write-Host "Manifest:        $manifest"
    Write-Host ("Manifest SHA-256 (record this): " + (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash)
  }
  'Verify' {
    if (-not (Test-Path -LiteralPath $dst) -or -not (Test-Path -LiteralPath $manifest)) { Fail "Missing $dst or $manifest." }
    Write-Host (Compare-ToManifest $dst $manifest)
  }
  'Restore' {
    if (-not $ConfirmRestore) { Fail 'Restore replaces the live folder. Repeat with -ConfirmRestore once you have decided to.' }
    if (-not (Test-Path -LiteralPath $dst) -or -not (Test-Path -LiteralPath $manifest)) { Fail "Missing $dst or $manifest." }
    Assert-Stopped $src
    Write-Host (Compare-ToManifest $dst $manifest)   # never restore from a backup that does not verify
    $aside = "$src.replaced-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    if (Test-Path -LiteralPath $src) { Move-Item -LiteralPath $src -Destination $aside }
    robocopy $dst $src /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "robocopy failed with exit code $LASTEXITCODE. The previous folder is intact at $aside." }
    Write-Host (Compare-ToManifest $src $manifest)
    Write-Host "Restored. The folder it replaced is kept at: $aside (delete it yourself once you are satisfied)."
  }
}
