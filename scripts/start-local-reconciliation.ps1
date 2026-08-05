param(
    [string]$Distro = 'Ubuntu-24.04',
    [switch]$ForwardOnly
)

$ErrorActionPreference = 'Stop'

function Assert-LoopbackDatabaseUrl {
    param([Parameter(Mandatory)][string]$DatabaseUrl)
    try { $uri = [Uri]$DatabaseUrl } catch { throw 'DATABASE_URL di .env.local tidak valid.' }
    if ($uri.Scheme -notin @('postgres', 'postgresql') -or $uri.Host -notin @('127.0.0.1', 'localhost', '::1')) {
        throw 'DATABASE_URL harus menunjuk PostgreSQL loopback lokal.'
    }
    if ($uri.Port -lt 1 -or $uri.Port -gt 65535) { throw 'Port DATABASE_URL tidak valid.' }
    return $uri.Port
}

if ($MyInvocation.InvocationName -eq '.') { return }

$envPath = Join-Path (Split-Path $PSScriptRoot) '.env.local'
if (-not (Test-Path -LiteralPath $envPath)) { throw '.env.local tidak ditemukan.' }
$databaseLine = Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -Last 1
if (-not $databaseLine) { throw 'DATABASE_URL tidak ditemukan di .env.local.' }
$databaseUrl = ($databaseLine -replace '^DATABASE_URL=', '').Trim().Trim('"').Trim("'")
$port = Assert-LoopbackDatabaseUrl -DatabaseUrl $databaseUrl

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw 'WSL tidak tersedia.' }
if (-not (Get-Command python.exe -ErrorAction SilentlyContinue)) { throw 'Python Windows tidak tersedia.' }

& wsl.exe -d $Distro -u root -- pg_ctlcluster 16 main start
if ($LASTEXITCODE -ne 0) { throw "PostgreSQL WSL gagal dimulai di distro $Distro." }

$forward = $null
try {
    $forward = Start-Process python.exe -WindowStyle Hidden -PassThru -ArgumentList @(
        "`"$(Join-Path $PSScriptRoot 'local-postgres-forward.py')`"", '--port', $port, '--distro', $Distro
    )
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        if ($forward.HasExited) { throw 'Forward PostgreSQL berhenti sebelum siap.' }
        $ready = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
    } until ($ready -or [DateTime]::UtcNow -ge $deadline)
    if (-not $ready) { throw "Forward PostgreSQL tidak siap di 127.0.0.1:$port." }

    Write-Output "PostgreSQL siap di 127.0.0.1:$port (forward PID $($forward.Id))."
    if ($ForwardOnly) {
        Write-Output 'Tekan Ctrl+C untuk menghentikan forward.'
        Wait-Process -Id $forward.Id
    } else {
        & npm.cmd run dev -- --hostname 127.0.0.1 --port 3000
    }
} finally {
    if ($forward -and -not $forward.HasExited) { Stop-Process -Id $forward.Id -Force }
}
