<#
 Fast local mode: the production build on a local PostgreSQL (Docker). Pages open in a fraction of a second, unlike
 `npm run dev`, which compiles every page when it is first opened.

   powershell -ExecutionPolicy Bypass -File scripts\local-production.ps1 [-Port 3100] [-Seed] [-SkipBuild]

 Needs Docker Desktop running. First run creates .local\pg-password.txt and .local\auth-secret.txt (random; never committed)
 and a PostgreSQL 17 container named "sportozen-pg" on 127.0.0.1 only. -Seed adds the FICTIONAL demo academies once
 (their password is in .local\seed-password.txt). Real data: never use -Seed. Stop the server with Ctrl+C; the database keeps
 its data in the Docker volume. See FAST_LOCAL_PRODUCTION.md.
#>
param(
  [int]$Port = 3100,
  [string]$Container = 'sportozen-pg',
  [int]$DbPort = 55432,
  [switch]$Seed,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force .local | Out-Null
function Get-LocalSecret([string]$File) {
  if (-not (Test-Path $File)) { ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')) | Set-Content -NoNewline $File }
  return (Get-Content $File -Raw).Trim()
}
$pgPassword = Get-LocalSecret '.local\pg-password.txt'
$authSecret = Get-LocalSecret '.local\auth-secret.txt'

$existing = docker ps -a --filter "name=^${Container}$" --format '{{.Names}}'
if ($existing) { docker start $Container | Out-Null }
else {
  docker run -d --name $Container -p "127.0.0.1:${DbPort}:5432" -e POSTGRES_PASSWORD=$pgPassword -e POSTGRES_DB=sportozen `
    -v "${Container}_data:/var/lib/postgresql/data" postgres:17-alpine | Out-Null
}
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  docker exec $Container pg_isready -U postgres *> $null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) { throw "PostgreSQL in container $Container did not become ready." }

$env:DATABASE_URL = "postgres://postgres:$pgPassword@127.0.0.1:${DbPort}/sportozen"
$env:BETTER_AUTH_SECRET = $authSecret
$env:BETTER_AUTH_URL = "http://127.0.0.1:$Port"
# Browsers share cookies between ports of one host; a name per port keeps two local servers from signing each other out.
$env:SPORTOZEN_COOKIE_PREFIX = "sz-bd-$Port"
npx tsx scripts/migrate.ts
if ($LASTEXITCODE -ne 0) { throw 'Migration failed.' }
if ($Seed) {
  $env:ALLOW_DEV_SEED = 'true'
  $env:DEV_SEED_PASSWORD = Get-LocalSecret '.local\seed-password.txt'
  npx tsx scripts/seed.ts
  Remove-Item Env:ALLOW_DEV_SEED, Env:DEV_SEED_PASSWORD
}
$env:NODE_ENV = 'production'
if (-not $SkipBuild) {
  npx next build --webpack
  if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
}
npx next start --hostname 127.0.0.1 --port $Port
