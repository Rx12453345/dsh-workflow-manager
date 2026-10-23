/**
 * dsh-workflow — core component.
 *
 * Host-only half: the model-facing tools and the workflow state machine. Safe to
 * enable on its own; the settings panel is a separate row and may stay disabled.
 *
 * `Config` is RE-EXPORTED deliberately. `dsh-settings` builds the settings
 * namespace directory from the module THAT ROW LOADS (`entry.fiber.runtime.Config`),
 * so a Loader row mounted at `<package>/core` only becomes configurable if this
 * entry carries the schema. Omitting it is silent: the row is dropped from the
 * directory, the browser page's namespace gate never opens, and nothing is logged.
 *
 * @module src-12453345_-dsh-workflow/core
 */

import { applyCore, Config } from '../../index.js'

export const name = 'dsh-workflow-core'

export { Config }

export function apply(ctx, config) {
  return applyCore(ctx, config)
}
