# P3: a stale lock (dead pid / old timestamp) is recovered, and the take-over says so.
$ErrorActionPreference = 'Stop'
$root = 'D:\DSH\P5\src-12453345_-dsh-workflow'
$workspace = 'D:\DSH\P5'
$lock = Join-Path $root 'tooling\.mutation-lock'
Remove-Item $lock -Force -ErrorAction SilentlyContinue
Push-Location $root

Write-Output '=== 3a. lock file whose holder pid is gone (the killed-mid-run case) ==='
# pid 134217712 is far outside any real pid range, so process.kill(pid, 0) answers ESRCH.
$deadPid = 134217712
$json = '{"pid":' + $deadPid + ',"at":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ',"host":"gone-host","label":"tooling/mutation-check-panel.mjs"}'
Set-Content -Path $lock -Value $json -Encoding ascii -NoNewline
Write-Output "wrote a lock whose holder is pid ${deadPid}: $json"
Write-Output ''
node tooling/mutation-check-client.mjs M3
Write-Output ''
Write-Output "harness exit: $LASTEXITCODE (0 = it ran anyway, i.e. the tool is not wedged)"
Write-Output "lock file after: $(Test-Path $lock)"
Write-Output ''

Write-Output '=== 3b. lock past the time cap, holder pid ALIVE (pid reuse / overrun case) ==='
# The pid is this shell's, which is definitely running: only the timestamp can free the lock.
$old = [DateTimeOffset]::UtcNow.AddHours(-2).ToUnixTimeMilliseconds()
$json = '{"pid":' + (Get-Process -Id $PID).Id + ',"at":' + $old + ',"host":"this-host","label":"tooling/mutation-check.mjs"}'
Set-Content -Path $lock -Value $json -Encoding ascii -NoNewline
Write-Output "wrote a 2-hour-old lock whose holder pid is alive: $json"
Write-Output ''
node tooling/mutation-check-panel.mjs M2
Write-Output ''
Write-Output "harness exit: $LASTEXITCODE"
Write-Output "lock file after: $(Test-Path $lock)"
Write-Output ''

Write-Output '=== 3c. the default cap is 30 minutes: a 2-minute-old lock with a LIVE pid is respected ==='
$myPid = $PID
$recent = [DateTimeOffset]::UtcNow.AddMinutes(-2).ToUnixTimeMilliseconds()
$json = '{"pid":' + $myPid + ',"at":' + $recent + ',"host":"this-host","label":"a live holder"}'
Set-Content -Path $lock -Value $json -Encoding ascii -NoNewline
Write-Output "wrote a 2-minute-old lock held by the live pid $myPid"
node "$workspace\proofs\lock-takeup.mjs" $lock "" "the next harness" 2>&1
Write-Output "take-up exit: $LASTEXITCODE (2 = refused, correctly: the holder really is alive and inside the cap)"
Get-Content $lock -Raw
Remove-Item $lock -Force -ErrorAction SilentlyContinue
Pop-Location
