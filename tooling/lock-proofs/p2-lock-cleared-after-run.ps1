# P2: the lock is released after a normal run, so a later run succeeds.
$ErrorActionPreference = 'Stop'
$root = 'D:\DSH\P5\src-12453345_-dsh-workflow'
$lock = Join-Path $root 'tooling\.mutation-lock'
Remove-Item $lock -Force -ErrorAction SilentlyContinue

Write-Output "step 1 — run the client harness alone (M1)"
Push-Location $root
node tooling/mutation-check-client.mjs M1 2>&1 | Select-Object -First 4
Write-Output "client harness exit: $LASTEXITCODE"
Write-Output "lock file left behind: $(Test-Path $lock)"
Write-Output ''

Write-Output "step 2 — run it again immediately (a later run must succeed)"
node tooling/mutation-check-client.mjs M2 2>&1 | Select-Object -First 4
Write-Output "second run exit: $LASTEXITCODE"
Write-Output "lock file left behind: $(Test-Path $lock)"
Write-Output ''

Write-Output "step 3 — a THIRD, different harness (the pair is irrelevant; one lock covers all six)"
node tooling/mutation-check-work-unit.mjs 2>&1 | Select-Object -Last 6
Write-Output "work-unit harness exit: $LASTEXITCODE"
Write-Output "lock file left behind: $(Test-Path $lock)"
Pop-Location
