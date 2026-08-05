$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/start-local-reconciliation.ps1"

$port = Assert-LoopbackDatabaseUrl -DatabaseUrl 'postgresql://user:secret@127.0.0.1:5432/database'
if ($port -ne 5432) { throw "Unexpected port: $port" }

foreach ($invalid in @('', 'not-a-url', 'postgresql://user:secret@192.168.1.10:5432/database', 'postgresql://user:secret@127.0.0.1:0/database')) {
    try {
        Assert-LoopbackDatabaseUrl -DatabaseUrl $invalid
        throw "Expected invalid database URL to fail: $invalid"
    } catch {
        if ($_.Exception.Message -like 'Expected invalid*') { throw }
    }
}

Write-Output 'OK - local reconciliation startup validates the WSL PostgreSQL endpoint.'
