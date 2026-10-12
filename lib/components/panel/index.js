/**
 * dsh-workflow — settings panel component (Host half).
 *
 * WHAT THIS PACKAGE IS FOR, CORRECTED. An earlier version of this comment claimed the
 * browser half was declared here by `exports["./panel/client"]` in the package
 * manifest. THAT EXPORT NEVER EXISTED and cannot exist usefully: `dsh-client-modules`
 * attaches a package's browser half to the Loader row whose specifier is the BARE
 * package name, and this row is mounted as `<package>/panel` — so a bundle declared
 * here would never be served. The comment described a thing that was not there.
 *
 * This module's real job is narrow and worth naming: the row exists so that
 * `dsh-settings` has a Loader entry to hang the PANEL namespace on. The two sidebar
 * fields (`showInSidebar`, `sidebarLabel`) and `showInPluginPage` are declared on this
 * row's schema, and the browser half of `lib/client.js` reads them back through
 * `ctx.configForms.get('dsh-workflow-panel')`. See `cordis.patch.yml` for the values.
 *
 * `Config` is re-exported for the same reason as in `../core/index.js`: the settings
 * namespace directory is built from the entry a row actually loads, so an
 * independently switchable row has to carry the schema itself — omitting it is silent.
 *
 * @module src-12453345_-dsh-workflow/panel
 */

import { applyPanel, Config } from '../../index.js'

export const name = 'dsh-workflow-panel'

export { Config }

export function apply(ctx, config) {
  return applyPanel(ctx, config)
}
