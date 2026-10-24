# P5: every mutation harness still works SINGLY and reports its normal result.
# One at a time: each is started, waited for, and its own exit code is read from that process.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$proofDir = Join-Path $env:TEMP 'dsh-workflow-lock-proofs'
New-Item -ItemType Directory -Force $proofDir | Out-Null
$lock = Join-Path $root 'tooling\.mutation-lock'

$harnesses = @(
  @{ name = 'mutation-check.mjs';              args = @() },
  @{ name = 'mutation-check-approval.mjs';     args = @() },
  @{ name = 'mutation-check-client.mjs';       args = @() },
  @{ name = 'mutation-check-panel.mjs';        args = @() },
  @{ name = 'mutation-check-project-tab.mjs';  args = @() },
  @{ name = 'mutation-check-work-unit.mjs';    args = @() }
)

foreach ($h in $harnesses) {
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
  $out = (Join-Path $proofDir "harness-$($h.name).log")
  $p = Start-Process -FilePath node -ArgumentList (@("tooling/$($h.name)") + $h.args) -WorkingDirectory $root -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError "$out.err"
  $p.WaitForExit(3600000) | Out-Null
  $lines = Get-Content $out -ErrorAction SilentlyContinue
  Write-Output "=================================================================="
  Write-Output "$($h.name)  ->  exit $($p.ExitCode)"
  Write-Output "  lock claimed at start:  $(($lines | Select-String -SimpleMatch 'mutation lock acquired').Count)"
  Write-Output "  lock still present:     $(Test-Path $lock)"
  Write-Output "  restore line:           $(($lines | Select-String -SimpleMatch 'restored byte-for-byte').Line)"
  Write-Output "  result lines:"
  $lines | Select-String -Pattern 'mutants killed|mutants caught|killable mutants|totals:|sources restored|post-restore|anchors verified|MUTATION RESULTS' | ForEach-Object { "    $($_.Line)" }
}
Write-Output "=================================================================="
Write-Output 'source tree at the end:'
foreach ($f in @('lib/client.js', 'lib/config-schema.js', 'lib/work-unit.js', 'lib/advance.js', 'lib/tools.js', 'lib/shared.js', 'lib/gc.js', 'lib/constraints.js', 'lib/approval.js', 'lib/index.js')) {
  Write-Output "  $f  $((Get-FileHash (Join-Path $root $f) -Algorithm SHA256).Hash)"
}
