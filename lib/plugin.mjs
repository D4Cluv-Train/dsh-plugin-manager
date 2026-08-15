/**
 * @d4cluvtrain/dsh-plugin-manager — a minimal dsh bundle plugin (MVP) that proves it loaded.
 *
 * Loaded by the profile Loader as the `plugin-manager` entry, it:
 *  1. waits for the web surface's `webServer` service (declared via inject),
 *  2. registers an exact HTTP route `GET /plugin-manager` whose JSON response is
 *     the "I loaded" proof (visible in a browser at the dsh web URL),
 *  3. writes a marker file into `$DSH_HOME` (headless verification),
 *  4. logs an apply line to the dsh logger.
 *
 * The entry also shows up in the web GUI under Settings → Plugins (the
 * plugin-inventory projection of the Loader tree) with phase `active`.
 *
 * Zero runtime dependencies: only node: builtins and the Cordis Context the
 * Loader hands to `apply`.
 */
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = '@d4cluvtrain/dsh-plugin-manager'

/** Do not apply until the web surface's HTTP carrier service exists. */
export const inject = ['webServer']

/** The exact path this plugin claims on the web server. */
export const ROUTE_PATH = '/plugin-manager'

export function apply(ctx) {
  const logger = ctx.logger('plugin-manager')
  logger.info('@d4cluvtrain/dsh-plugin-manager applied — registering %s', ROUTE_PATH)

  // Route registration is the visible proof: after the profile boots,
  // http://<dsh-web-host>:<port>/plugin-manager answers with this payload.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        plugin: name,
        status: 'loaded',
        message: 'Hello from @d4cluvtrain/dsh-plugin-manager — the bundle loaded successfully.',
        route: ROUTE_PATH,
        appliedAt: new Date().toISOString(),
      }, null, 2) + '\n')
    },
  }), `${name}: ${ROUTE_PATH} route`)

  // Marker file for headless verification (e.g. the smoke script): its
  // presence proves `apply` ran inside a booted dsh profile. The dsh home is
  // `$DSH_HOME` when set, else the conventional `~/.dsh`.
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const marker = join(home, '@d4cluvtrain/dsh-plugin-manager.loaded')
  try {
    writeFileSync(marker, JSON.stringify({
      plugin: name,
      appliedAt: new Date().toISOString(),
      pid: process.pid,
      route: ROUTE_PATH,
    }, null, 2) + '\n')
    logger.info('wrote load marker %s', marker)
  } catch (error) {
    logger.warn('failed to write load marker: %s', String(error))
  }
}
