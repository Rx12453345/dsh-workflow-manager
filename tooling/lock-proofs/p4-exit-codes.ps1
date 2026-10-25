# P4a: exit codes, measured properly.
# A piped native command makes $LASTEXITCODE the pipeline's, so each run here goes through
# Start-Process ... -Wait and reads that exact process's ExitCode.
# Scope: the only process this script starts and stops is the single holder below; it is
# stopped through the job handle created for it, never by name, age or any other heuristic.
# (Start-Process -ArgumentList takes ONE string, so it was mangling argv for the child; a job
# passes the array verbatim, which is why the holder is started as a job.)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$proofDir = Join-Path $env:TEMP 'dsh-workflow-lock-proofs'
New-Item -ItemType Directory -Force $proofDir | Out-Null
$lock = Join-Path $root 'tooling\.mutation-lock'
$child = Join-Path $root 'tooling\mutation-lock-holder-child.mjs'
$sink = (Join-Path $proofDir 'out-sink.log')

function Run-Node([string[]]$nodeArgs) {
  $p = Start-Process -FilePath node -ArgumentList $nodeArgs -WorkingDirectory $root -PassThru -NoNewWindow -RedirectStandardOutput $sink -RedirectStandardError "$sink.err"
  $p.WaitForExit(900000) | Out-Null
  return $p.ExitCode
}

Remove-Item $lock -Force -ErrorAction SilentlyContinue

Write-Output '=== 4a. a normal single harness run exits 0 and clears the lock ==='
$code = Run-Node @('tooling/mutation-check-client.mjs', 'M1')
Write-Output "tooling/mutation-check-client.mjs M1  -> exit $code   lock left behind: $(Test-Path $lock)"
Write-Output ''

Write-Output '=== 4b. the second harness refuses with exit 2 while the first holds the lock ==='
# The lock path goes through the environment, not argv: a job re-splits the command line, so a
# positional path argument would shift every argument after it (this bit me once already).
$holder = Start-Job -ScriptBlock {
  param($c, $l)
  $env:MUTATION_LOCK_PATH = $l
  $env:MUTATION_HOLD_MS = '30000'
  node $c
} -ArgumentList $child, $lock
$deadline = (Get-Date).AddSeconds(40)
while (-not (Test-Path $lock)) {
  if ((Get-Date) -gt $deadline) { throw "the holder never took the lock: $(Receive-Job $holder)" }
  Start-Sleep -Milliseconds 100
}
$heldBy = Get-Content $lock -Raw
Write-Output "holder job holds the lock: $heldBy"
$code = Run-Node @('tooling/mutation-check-panel.mjs')
Write-Output "tooling/mutation-check-panel.mjs -> exit $code   (holder still running when it refused: $($holder.State -eq 'Running'))"
Get-Content "$sink.err" | Select-Object -First 3
Stop-Job $holder
Remove-Job $holder -Force
Write-Output "holder stopped by its own job handle; lock now: $(Test-Path $lock)"
Remove-Item $lock -Force -ErrorAction SilentlyContinue
Write-Output ''

Write-Output '=== 4c. the source tree is untouched ==='
$client = Join-Path $root 'lib\client.js'
Write-Output "client.js sha256 = $((Get-FileHash $client -Algorithm SHA256).Hash)"
Get-Content $sink | Select-Object -Last 2
