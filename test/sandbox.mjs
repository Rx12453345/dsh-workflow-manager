/**
 * The one place a test asks "is this run inside the DSH Windows sandbox?".
 *
 * WHY THIS EXISTS. The sandbox denies a child process a piped stdio (EPERM), and it also
 * cannot launch the Chromium-family browser the layout test needs. Those are ENVIRONMENT
 * failures, not code failures: without a skip, the suite reports six red tests for a
 * perfectly good change, and the obvious-but-wrong response is to treat the suite as broken
 * or, worse, to weaken the assertions.
 *
 * THE RUNNER SETS THE FLAG, NOT THE TEST. `run-unit-tests.mjs` probes a trivial piped child
 * once; when it gets EPERM it sets `DSH_WORKFLOW_SANDBOX=1` for the whole test process. A
 * normal terminal never sets it, so every test still runs and still fails on a real defect.
 * A skip is therefore always visible in the summary, with the reason attached.
 *
 * Only tests that CANNOT run in the sandbox use this helper. Everything else runs unchanged.
 */

/** Whether this test process was started by the runner in sandbox mode. */
export const SANDBOX = process.env.DSH_WORKFLOW_SANDBOX === '1'

/**
 * Skip the current test in sandbox mode, with a reason.
 *
 * @param t - the Node test context.
 * @param reason - what the sandbox prevents, in one line.
 * @returns true when the test was skipped and the caller must return immediately.
 */
export function skipInSandbox(t, reason) {
  if (!SANDBOX) return false
  t.skip(`DSH sandbox: ${reason}`)
  return true
}
