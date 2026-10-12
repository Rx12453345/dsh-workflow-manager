# P1: one harness running, a second started while it runs.
# The real hazard: two harnesses on the SAME file (client.js), which is what happened.
$ErrorActionPreference = 'Stop'
$root = 'D:\DSH\P5\src-12453345_-dsh-workflow'
$tooling = Join-Path $root 'tooling'
$lock = Join-Path $tooling '.mutation-lock'
$outA = 'D:\DSH\P5\p1-a.log'
$outB = 'D:\DSH\P5\p1-b.log'
$errB = 'D:\DSH\P5\p1-b.err'
foreach ($p in @($lock, $outA, $outB, $errB)) { Remove-Item $p -Force -ErrorAction SilentlyContinue }

$client = Join-Path $root 'lib\client.js'
$before = (Get-FileHash $client -Algorithm SHA256).Hash
Write-Output "client.js sha256 before anything: $before"
Write-Output "lock file exists before: $(Test-Path $lock)"
Write-Output ''

# A: the client harness, M12 only (enough that it holds the lock for a few seconds).
# B: the panel harness, M1 only — same file (client.js), so this is exactly the pair that
#    left two mutants applied on 2026-10-12.
$a = Start-Process -FilePath node -ArgumentList 'tooling/mutation-check-client.mjs', 'M12' -WorkingDirectory $root -PassThru -NoNewWindow -RedirectStandardOutput $outA -RedirectStandardError 'D:\DSH\P5\p1-a.err'
Write-Output "A = tooling/mutation-check-client.mjs M12  (pid $($a.Id))"

$deadline = (Get-Date).AddSeconds(60)
while (-not (Test-Path $lock)) {
  if ((Get-Date) -gt $deadline) { throw 'A never took the lock' }
  Start-Sleep -Milliseconds 100
}
Write-Output "A has taken the lock: $(Test-Path $lock)"
Write-Output "lock body while held: $(Get-Content $lock -Raw)"
Write-Output ''

$bStart = Get-Date
$b = Start-Process -FilePath node -ArgumentList 'tooling/mutation-check-panel.mjs', 'M1' -WorkingDirectory $root -PassThru -NoNewWindow -RedirectStandardOutput $outB -RedirectStandardError $errB
$b.WaitForExit(120000) | Out-Null
$bSeconds = ((Get-Date) - $bStart).TotalSeconds
Write-Output "B = tooling/mutation-check-panel.mjs M1  (pid $($b.Id))"
Write-Output "B exit code: $($b.ExitCode)   (took $([math]::Round($bSeconds,1))s)"
Write-Output "A still running when B exited: $(-not $a.HasExited)"
Write-Output ''
Write-Output '--- B stdout+stderr (verbatim) ---'
Get-Content $outB, $errB -ErrorAction SilentlyContinue | ForEach-Object { $_ }
Write-Output '--- end B ---'
Write-Output ''

$a.WaitForExit(600000) | Out-Null
Write-Output "A exit code: $($a.ExitCode)"
Write-Output "lock file exists after A finished: $(Test-Path $lock)"
$after = (Get-FileHash $client -Algorithm SHA256).Hash
Write-Output "client.js sha256 after both finished: $after"
Write-Output "source tree untouched (same hash): $($before -eq $after)"
Write-Output ''
Write-Output '--- A tail ---'
Get-Content $outA | Select-Object -Last 8
