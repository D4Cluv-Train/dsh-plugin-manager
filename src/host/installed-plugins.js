/**
 * dsh-hello-plugin — host-side "installed plugins" remote service.
 *
 * Publishes the Typert Remote `installedPlugins/list`: the list of plugins the
 * user installed THEMSELVES via `dsh plugin --profile <name> add <pkg>`, i.e.
 * profile bundle layers that are also declared dependencies. The shipped
 * template bundles (@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app) are never
 * dependencies of the profile — they resolve from the dsh installation — so
 * they are excluded by construction. This mirrors how the `dsh plugin`
 * command reconciles `dsh.profile.bundles` against installed dependencies.
 *
 * The browser client calls this through `ctx.remote.installedPlugins.list()`
 * (api-remotes transport; Gateway source-mode discovery finds the Remote
 * method from the `TypertRemoteService` binding + `@Remote` marker).
 *
 * Decorators are compiled by `npm run build` (esbuild) — Node does not run the
 * decorator syntax natively.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export const name = 'installed-plugins'

/** One self-installed profile bundle. */
export class InstalledPluginsGateway extends TypertRemoteService {
  /**
   * Register the `installedPlugins` service (and its Typert Gateway binding).
   * @param ctx - owning Cordis context (the profile tree root).
   */
  constructor(ctx) {
    super(ctx, 'installedPlugins')
  }

  /**
   * List user-installed profile bundles.
   * @returns `{ entries }` where each entry is `{ name }`.
   */
  @Remote('list')
  list() {
    // ctx.baseUrl is the profile directory (boot anchors it at the profile's
    // cordis.yml). The profile manifest carries both halves of the contract:
    // dsh.profile.bundles (ordered bundle layers) and dependencies (what the
    // user's `dsh plugin add` actually installed).
    let manifest
    try {
      const profileDir = fileURLToPath(this.ctx.baseUrl)
      manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    } catch (error) {
      return { entries: [], error: String(error) }
    }
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const dependencies = Object.keys(manifest.dependencies ?? {})
    const entries = bundles
      .filter(packageName => dependencies.includes(packageName))
      .map(packageName => ({ name: packageName }))
    return { entries }
  }
}

/**
 * Mount the gateway service.
 * @param ctx - client root context.
 */
export const apply = (ctx) => {
  new InstalledPluginsGateway(ctx)
}
