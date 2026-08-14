/**
 * Isolated boot smoke test for dsh-hello-plugin.
 *
 * Boots the dsh built bin (`apps/cli/lib/bin.js`) against a scratch DSH_HOME
 * whose `smoke` profile installs THIS bundle (same link layout pnpm uses) plus
 * a stub `webServer` provider. Success = the plugin's load marker appears
 * under the scratch home, i.e. the bundle resolved, the Loader mounted the
 * `hello-plugin` entry, `inject: ['webServer']` was satisfied, and `apply`
 * ran (route registration included). The real web profile needs no restart
 * for this check — it never touches the real DSH_HOME or any port.
 *
 * Usage: node scripts/smoke.mjs [path-to-built-dsh-bin]
 * Defaults to the checkout's apps/cli/lib/bin.js (override DSH_CHECKOUT).
 */
import { spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
// The dsh checkout lives beside this workspace (sibling of the `plugins`
// directory that contains this project): derive it instead of hardcoding a
// machine-specific absolute path. Override with DSH_CHECKOUT or argv[2].
const defaultCheckout = fileURLToPath(new URL('../../../deepseek-harness/', import.meta.url))
const checkout = process.env.DSH_CHECKOUT ?? defaultCheckout
const dshBin = process.argv[2] ?? join(checkout, 'apps/cli/lib/bin.js')
if (!existsSync(dshBin)) {
  console.error(`smoke: dsh bin not found at ${dshBin} (pass the path or set DSH_CHECKOUT)`)
  process.exit(1)
}

const home = mkdtempSync(join(tmpdir(), 'dsh-hello-smoke-'))
const profileDir = join(home, 'profiles', 'smoke')
const nodeModules = join(profileDir, 'node_modules')
mkdirSync(nodeModules, { recursive: true })

// "Installed" bundle: the same symlink layout pnpm's link: dependency uses.
const link = join(nodeModules, 'dsh-hello-plugin')
rmSync(link, { recursive: true, force: true })
symlinkSync(projectRoot, link, 'junction')

writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-smoke',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['dsh-hello-plugin'] } },
}, undefined, 2) + '\n')

// Minimal webServer provider so the plugin's inject is satisfiable without
// booting the whole web app. Records registrations for the assertion below.
const stubPath = join(profileDir, 'stub-webserver.mjs')
writeFileSync(stubPath, [
  "import { writeFileSync } from 'node:fs'",
  "export const name = 'stub-webserver'",
  'export function apply(ctx) {',
  '  const routes = []',
  "  ctx.provide('webServer', {",
  '    register(route) {',
  '      routes.push(route)',
  "      writeFileSync(process.env.SMOKE_ROUTES_FILE, JSON.stringify(routes, null, 2) + '\\n')",
  '      return () => {}',
  '    },',
  '  })',
  "  ctx.effect(() => () => { routes.length = 0 })",
  '}',
  '',
].join('\n'))

writeFileSync(join(profileDir, 'cordis.patch.yml'), [
  '- insert:',
  '    - id: stub-webserver',
  `      name: ${pathToFileURL(stubPath).href}`,
  '',
].join('\n'))

const marker = join(home, 'dsh-hello-plugin.loaded')
const routesFile = join(home, 'routes.json')
const bootLog = join(home, 'boot.log')

const child = spawn(process.execPath, [dshBin, '--profile', 'smoke'], {
  cwd: home,
  env: { ...process.env, DSH_HOME: home, SMOKE_ROUTES_FILE: routesFile },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const lines = []
child.stdout.on('data', (chunk) => lines.push(chunk.toString()))
child.stderr.on('data', (chunk) => lines.push(chunk.toString()))
writeFileSync(bootLog, '')

const deadline = Date.now() + 30_000
let ok = false
while (Date.now() < deadline) {
  if (existsSync(marker)) { ok = true; break }
  if (child.exitCode !== null || child.signalCode !== null) break
  await new Promise((resolve) => setTimeout(resolve, 200))
}
writeFileSync(bootLog, lines.join(''))

if (child.exitCode === null && child.signalCode === null) {
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 10_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

let status = 'FAIL'
if (ok) {
  const routeRecorded = existsSync(routesFile)
    && readFileSync(routesFile, 'utf8').includes('"/hello-plugin"')
  if (routeRecorded) {
    status = 'PASS'
  } else {
    console.error('smoke: marker present but no /hello-plugin route registration recorded')
  }
}

console.log(`smoke: ${status} (profile boot exit ${child.exitCode ?? 'still-running->killed'})`)
if (ok) {
  console.log('marker:', readFileSync(marker, 'utf8').trim())
  if (existsSync(routesFile)) console.log('routes:', readFileSync(routesFile, 'utf8').trim())
} else {
  console.error('--- boot log tail ---')
  console.error(lines.slice(-40).join(''))
  console.error('---')
}

rmSync(home, { recursive: true, force: true })
process.exit(status === 'PASS' ? 0 : 1)
