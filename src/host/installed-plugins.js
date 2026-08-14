/**
 * dsh-hello-plugin — host-side "installed plugins" remote service.
 *
 * Publishes the Typert Remote `installedPlugins` namespace with two methods:
 *   - `list`: the user-installed bundles (profile bundle layers that are also
 *     declared dependencies) with their live Loader status (enabled + fiber
 *     phase). The shipped template bundles (@deepseek-ai/dsh-base,
 *     @deepseek-ai/dsh-web-app) are never profile dependencies, so they are
 *     excluded by construction.
 *   - `apply`: enable/disable those bundles by writing id-targeted
 *     `{ id, disabled: true }` rows into the profile `cordis.patch.yml`
 *     (see plugin-patches.js). The boot HMR watcher live-applies the change to
 *     the host entries; a bundle that ships a web `dsh.client` half is reported
 *     in `needsReload` because its browser UI only unloads on page reload.
 *
 * The browser client calls these through `ctx.remote.installedPlugins.*`
 * (api-remotes transport; Gateway source-mode discovery finds the Remote
 * methods from the `TypertRemoteService` binding + `@Remote` markers).
 *
 * Decorators are compiled by `npm run build` (esbuild) — Node does not run the
 * decorator syntax natively. esbuild preserves method parameter names, which
 * the Gateway's SRC descriptor path reads via `Function#toString`, so the
 * `apply(changes)` parameter name must stay a plain identifier.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { applyEnabledChanges, readPatchRows } from './plugin-patches.js'

export const name = 'installed-plugins'

/** This bundle's package name — the manager must never disable itself. */
const SELF_PACKAGE = 'dsh-hello-plugin'

/** Cordis FiberState → phase string mirror (see plugin-inventory). */
const FIBER_PHASE = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
}

/** Worst-first ordering for aggregating several entries into one phase. */
const PHASE_RANK = { active: 0, pending: 1, loading: 2, unloading: 3, failed: 4 }

function aggregatePhase(rows) {
  let worst = null
  let rank = -1
  for (const row of rows) {
    if (row.fiberPhase === null) continue
    const r = PHASE_RANK[row.fiberPhase] ?? 0
    if (r > rank) { rank = r; worst = row.fiberPhase }
  }
  return worst
}

/** One self-installed profile bundle (live status included). */
export class InstalledPluginsGateway extends TypertRemoteService {
  static inject = ['loader']

  /**
   * Register the `installedPlugins` service (and its Typert Gateway binding).
   * @param ctx - owning Cordis context (the profile tree root).
   */
  constructor(ctx) {
    super(ctx, 'installedPlugins')
  }

  /** Entry ids contributed by a package (its Loader rows, by module specifier). */
  entryIdsFor(packageName) {
    const ids = []
    for (const entry of this.ctx.loader.entries()) {
      const moduleName = entry.options.name
      if (moduleName === packageName || moduleName.startsWith(`${packageName}/`)) {
        ids.push(entry.options.id)
      }
    }
    return ids
  }

  /** Live status of one package: enabled + worst fiber phase across its entries. */
  describe(packageName) {
    const rows = []
    for (const entry of this.ctx.loader.entries()) {
      const moduleName = entry.options.name
      if (moduleName === packageName || moduleName.startsWith(`${packageName}/`)) {
        rows.push({
          entryId: entry.options.id,
          enabled: !entry.disabled,
          fiberPhase: entry.fiber === undefined ? null : (FIBER_PHASE[entry.fiber.state] ?? null),
        })
      }
    }
    return {
      name: packageName,
      self: packageName === SELF_PACKAGE,
      enabled: rows.length > 0 && rows.every((row) => row.enabled),
      fiberPhase: aggregatePhase(rows),
    }
  }

  /** Whether a package ships a web client half (browser UI needing a reload). */
  hasClientHalf(profileDir, packageName) {
    try {
      const pkg = JSON.parse(readFileSync(join(profileDir, 'node_modules', packageName, 'package.json'), 'utf8'))
      return pkg?.dsh?.client?.platform === 'web'
    } catch {
      return false
    }
  }

  /**
   * List user-installed profile bundles with status.
   * @returns `{ entries }` where each entry is `{ name, self, enabled, fiberPhase }`.
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
      .filter((packageName) => dependencies.includes(packageName))
      .map((packageName) => this.describe(packageName))
    return { entries }
  }

  /**
   * Enable/disable a set of bundles. Takes effect on write (host entries are
   * live-reloaded by the boot HMR watcher); bundles with a client half are
   * reported for the caller to prompt a reload.
   * @param changes - `[{ name, enabled }]`.
   * @returns `{ needsReload, names }`.
   */
  @Remote('apply')
  async apply(changes) {
    const profileDir = fileURLToPath(this.ctx.baseUrl)
    const file = join(profileDir, 'cordis.patch.yml')
    const changesById = new Map()
    const names = []
    for (const change of changes ?? []) {
      const packageName = change?.name
      if (typeof packageName !== 'string' || packageName === '') continue
      if (packageName === SELF_PACKAGE) continue
      const ids = this.entryIdsFor(packageName)
      if (ids.length === 0) continue
      const disable = change.enabled !== true
      for (const id of ids) changesById.set(id, disable)
      if (this.hasClientHalf(profileDir, packageName)) names.push(packageName)
    }
    if (changesById.size > 0) {
      await applyEnabledChanges(file, changesById)
      // Fail-loud verification: a write that did not produce the requested
      // disabled state (e.g. an id the composed tree does not carry) is a real
      // error, not a silent no-op. The patch engine only warns on missing ids.
      const rows = await readPatchRows(file)
      const missing = []
      for (const [id, disable] of changesById) {
        const row = rows.find((candidate) =>
          candidate !== null && typeof candidate === 'object'
          && candidate.id === id && typeof candidate.disabled === 'boolean')
        if ((row?.disabled === true) !== disable) missing.push(id)
      }
      if (missing.length > 0) {
        throw new Error(`enable/disable verification failed for entries: ${missing.join(', ')}`)
      }
    }
    return { needsReload: names.length > 0, names }
  }
}

/**
 * Mount the gateway service.
 * @param ctx - client root context.
 */
export const apply = (ctx) => {
  new InstalledPluginsGateway(ctx)
}
