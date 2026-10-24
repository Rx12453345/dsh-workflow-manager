# P4d: a harness hard-killed while it holds the lock, and the next run recovering it.
#
# PROCESS SCOPE, stated before the stop: this script starts exactly ONE node process (the
# victim, `tooling/mutation-check-work-unit.mjs`) and stops exactly that same process, through
# the handle Start-Process returned for it. It never selects a process by name, image, age or
# any other heuristic, and it touches no process it did not start.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$proofDir = Join-Path $env:TEMP 'dsh-workflow-lock-proofs'
New-Item -ItemType Directory -Force $proofDir | Out-Null
$lock = Join-Path $root 'tooling\.mutation-lock'
$victimSink = (Join-Path $proofDir 'out-victim.log')
$nextSink = (Join-Path $proofDir 'out-next.log')
Remove-Item $lock -Force -ErrorAction SilentlyContinue

$victim = Start-Process -FilePath node -ArgumentList 'tooling/mutation-check-work-unit.mjs' -WorkingDirectory $root -PassThru -NoNewWindow -RedirectStandardOutput $victimSink -RedirectStandardError "$victimSink.err"
Write-Output "victim = pid $($victim.Id) (tooling/mutation-check-work-unit.mjs, 23 mutants, ~2 minutes)"

$deadline = (Get-Date).AddSeconds(60)
while (-not (Test-Path $lock)) {
  if ((Get-Date) -gt $deadline) { throw 'the victim never took the lock' }
  if ($victim.HasExited) { throw "the victim exited early: $(Get-Content $victimSink -Raw)" }
  Start-Sleep -Milliseconds 100
}
Write-Output "victim holds the lock: $(Get-Content $lock -Raw)"
$completed = (Get-Content $victimSink -ErrorAction SilentlyContinue | Select-String -SimpleMatch 'KILLED').Count
Write-Output "mutants it had already tested and restored: $completed"

$victim.Kill()
$victim.WaitForExit(10000) | Out-Null
Write-Output "victim (pid $($victim.Id)) stopped; exit code $($victim.ExitCode)"
Write-Output "lock file after the hard stop: $(Test-Path $lock)   <- the wedge the recovery path exists for"

$next = Start-Process -FilePath node -ArgumentList 'tooling/mutation-check-client.mjs', 'M3' -WorkingDirectory $root -PassThru -NoNewWindow -RedirectStandardOutput $nextSink -RedirectStandardError "$nextSink.err"
$next.WaitForExit(900000) | Out-Null
Write-Output "next harness (pid $($next.Id)) -> exit $($next.ExitCode)   (0 = it took over instead of waiting 30 minutes)"
Write-Output 'take-over line it printed:'
Select-String -Path "$nextSink.err" -Pattern 'taking over a stale lock' -SimpleMatch | ForEach-Object { $_.Line }
Write-Output "lock after the recovering run: $(Test-Path $lock)"
Get-Content $nextSink | Select-Object -Last 2
