/**
 * dsh-plugin-manager — host-side "installed plugins" remote service.
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

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { applyEnabledChanges, readPatchRows } from './plugin-patches.js'

export const name = 'installed-plugins'

/** This bundle's package name — the manager must never disable itself. */
const SELF_PACKAGE = 'dsh-plugin-manager'

/** awesome-dsh-plugin data sources for the discover tab. */
const AWESOME_README_URL = 'https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/README.md'
const AWESOME_NPM_MAP_URL = 'https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/data/npm-map.json'

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

/**
 * Collect the entry ids (and their module specifiers) a bundle patch layer
 * inserts — top-level rows and children nested in group entries. Aggregator
 * bundles insert rows named after their sub-packages (e.g. `@linxin666/dsh-pet`),
 * so a module-name match against the package alone misses most of them; the
 * bundle's own `cordis.patch.yml` is the authoritative list of what it owns.
 * @param patches - parsed patch list from the bundle's `dsh.bundle.patch`.
 * @param ids - Set of contributed entry ids to fill.
 * @param modules - Set of contributed module specifiers to fill.
 */
function collectContributed(patches, ids, modules) {
  for (const patch of patches ?? []) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) continue
    if (!Array.isArray(patch.insert)) continue
    for (const entry of patch.insert) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      if (typeof entry.id === 'string' && entry.id !== '') ids.add(entry.id)
      if (typeof entry.name === 'string' && entry.name !== '') modules.add(entry.name)
      if (entry.group === true && Array.isArray(entry.config)) {
        collectContributed(entry.config, ids, modules)
      }
    }
  }
}

/**
 * Parse the awesome-dsh-plugin README plugin list into discover entries. Each
 * `- [owner/repo](url) - summary` row under a `### category` heading becomes
 * one entry; the install spec is the npm package name from `npm-map.json` when
 * the plugin ships on npm, else the git repo URL.
 * @param readme - raw README.md text of the awesome repo.
 * @param npmMap - parsed `data/npm-map.json` (repo URL → `{ npm }`).
 * @returns `{ category, name, url, summary, spec }[]`.
 */
function parseAwesomePlugins(readme, npmMap) {
  const plugins = []
  let category = ''
  let inPlugins = false
  for (const line of readme.split(/\r?\n/)) {
    if (/^##\s+/.test(line)) {
      inPlugins = line.startsWith('## Plugins')
      continue
    }
    if (!inPlugins) continue
    const heading = /^###\s+(.+)$/.exec(line)
    if (heading) {
      category = heading[1].trim()
      continue
    }
    const entry = /^-\s+\[([^\]]+)\]\(([^)]+)\)(?:\s*-\s*(.*))?$/.exec(line.trim())
    if (entry === null) continue
    const name = entry[1].split('#')[0]
    const summary = (entry[3] ?? '').trim()
    const repoUrl = `https://github.com/${name}`
    const spec = npmMap[repoUrl]?.npm ?? repoUrl
    plugins.push({ category, name, url: entry[2], summary, spec })
  }
  return plugins
}

/** Whether a package directory declares a dsh bundle patch. */
function isBundleDir(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof pkg?.dsh?.bundle?.patch === 'string' && pkg.dsh.bundle.patch !== ''
  } catch {
    return false
  }
}

/**
 * Reconcile `dsh.profile.bundles` against the profile's installed dependencies:
 * a dependency that resolves to a `dsh.bundle`-declaring package joins the
 * layer stack (mirrors the CLI's reconcilePlugins). Writes only on change.
 * @param profileDir - profile directory.
 */
function reconcileBundles(profileDir) {
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const dependencies = Object.keys(manifest.dependencies ?? {})
  let changed = false
  for (const packageName of dependencies) {
    if (bundles.includes(packageName)) continue
    if (isBundleDir(join(profileDir, 'node_modules', packageName))) {
      bundles.push(packageName)
      changed = true
    }
  }
  if (changed) {
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  }
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

  /**
   * Entry ids (and modules) a package contributes. Primary source: the
   * bundle's own `dsh.bundle.patch` (`cordis.patch.yml`), which lists every row
   * it inserts; fallback: Loader rows whose module specifier is the package (or
   * a subpath). Aggregator bundles name most inserted rows after sub-packages,
   * so both sources are merged.
   * @param profileDir - profile directory (resolution anchor for node_modules).
   * @param packageName - the bundle's package name.
   */
  async entryIdsFor(profileDir, packageName) {
    const ids = new Set()
    const modules = new Set()
    try {
      const pkgDir = join(profileDir, 'node_modules', packageName)
      const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
      const patchRel = pkg?.dsh?.bundle?.patch
      if (typeof patchRel === 'string' && patchRel !== '') {
        const patches = await readPatchRows(join(pkgDir, patchRel))
        collectContributed(patches, ids, modules)
      }
    } catch {
      // Unreadable/unparseable patch — fall back to the Loader-row match below.
    }
    for (const entry of this.ctx.loader.entries()) {
      const moduleName = entry.options.name
      if (moduleName === packageName || moduleName.startsWith(`${packageName}/`)) {
        ids.add(entry.options.id)
        modules.add(moduleName)
      }
    }
    return { ids: [...ids], modules: [...modules] }
  }

  /** Live status of one package: enabled + worst fiber phase across its entries. */
  async describe(profileDir, packageName) {
    const { ids } = await this.entryIdsFor(profileDir, packageName)
    const byId = new Map()
    for (const entry of this.ctx.loader.entries()) byId.set(entry.options.id, entry)
    const rows = ids
      .map(id => byId.get(id))
      .filter(entry => entry !== undefined)
      .map(entry => ({
        entryId: entry.options.id,
        enabled: !entry.disabled,
        fiberPhase: entry.fiber === undefined ? null : (FIBER_PHASE[entry.fiber.state] ?? null),
      }))
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
  async list() {
    // ctx.baseUrl is the profile directory (boot anchors it at the profile's
    // cordis.yml). The profile manifest carries both halves of the contract:
    // dsh.profile.bundles (ordered bundle layers) and dependencies (what the
    // user's `dsh plugin add` actually installed).
    const profileDir = fileURLToPath(this.ctx.baseUrl)
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    } catch (error) {
      return { entries: [], error: String(error) }
    }
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const dependencies = Object.keys(manifest.dependencies ?? {})
    const entries = []
    for (const packageName of bundles) {
      if (!dependencies.includes(packageName)) continue
      entries.push(await this.describe(profileDir, packageName))
    }
    return { entries }
  }

  /**
   * Enable/disable a set of bundles. Takes effect on write (host entries are
   * live-reloaded by the boot HMR watcher); bundles with a client half — their
   * own or any contributed entry's module — are reported for the caller to
   * prompt a reload.
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
      const { ids, modules } = await this.entryIdsFor(profileDir, packageName)
      if (ids.length === 0) continue
      const disable = change.enabled !== true
      for (const id of ids) changesById.set(id, disable)
      if (this.hasClientHalf(profileDir, packageName)
        || modules.some(moduleName => this.hasClientHalf(profileDir, moduleName))) {
        names.push(packageName)
      }
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

  /**
   * List plugins from the awesome-dsh-plugin registry (name / summary / source
   * / install spec). Fetched live from GitHub on every call.
   * @returns `{ plugins }` where each plugin is `{ category, name, url, summary, spec }`.
   */
  @Remote('discover')
  async discover() {
    const [readmeText, npmMap] = await Promise.all([
      fetch(AWESOME_README_URL).then((res) => {
        if (!res.ok) throw new Error(`discover: ${AWESOME_README_URL} returned ${res.status}`)
        return res.text()
      }),
      fetch(AWESOME_NPM_MAP_URL).then((res) => {
        if (!res.ok) throw new Error(`discover: ${AWESOME_NPM_MAP_URL} returned ${res.status}`)
        return res.json()
      }),
    ])
    return { plugins: parseAwesomePlugins(readmeText, npmMap) }
  }

  /**
   * Install a plugin package into the current profile (pnpm add + bundle
   * reconcile). The new bundle is discovered at boot, so a restart is required.
   * @param spec - package name or git URL to install (the argument to `dsh plugin add`).
   * @returns `{ needsRestart, name }`.
   */
  @Remote('installPlugin')
  async installPlugin(spec) {
    if (typeof spec !== 'string' || spec === '' || spec.startsWith('-')) {
      throw new Error('install: invalid package spec')
    }
    const profileDir = fileURLToPath(this.ctx.baseUrl)
    const result = spawnSync('pnpm', ['add', spec], {
      cwd: profileDir,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    })
    if (result.error !== undefined) {
      if (result.error.code === 'ENOENT') throw new Error('install: pnpm not found on PATH')
      throw result.error
    }
    if (result.status !== 0) {
      const detail = String(result.stderr ?? result.stdout ?? '').slice(0, 500)
      throw new Error(`pnpm add ${spec} failed (${result.status}): ${detail}`)
    }
    reconcileBundles(profileDir)
    return { needsRestart: true, name: spec }
  }
}

/**
 * Mount the gateway service.
 * @param ctx - client root context.
 */
export const apply = (ctx) => {
  new InstalledPluginsGateway(ctx)
}
