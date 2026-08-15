/**
 * Loader-contract simulation for the built client bundle (no browser needed).
 *
 * Mirrors what the browser's ClientModuleSystem does:
 *  1. installs a fake `window.__ModuleLoader__` that captures the handoff,
 *  2. executes lib/client.js (the bundle registers via __ModuleLoader__.load),
 *  3. materializes the factory with a `require` that answers the externals
 *     (react from the checkout; stubs for UI primitives),
 *  4. asserts the export shape, that `apply` mounts the installedPlugins
 *     Remote contribution through `ctx.remote.$mount`, and that it registers
 *     the locale dictionary and the sidebar footer action without throwing.
 *
 * Usage: node scripts/verify-client.mjs [path-to-checkout]
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
// The dsh checkout lives beside this workspace (sibling of the `plugins`
// directory that contains this project): derive it instead of hardcoding a
// machine-specific absolute path. Override with DSH_CHECKOUT.
const defaultCheckout = fileURLToPath(new URL('../../../deepseek-harness/', import.meta.url))
const checkout = process.env.DSH_CHECKOUT ?? defaultCheckout
const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
if (!existsSync(bundlePath)) {
  console.error('verify-client: lib/client.js missing — run `npm run build:client` first')
  process.exit(1)
}

// 1. fake loader + global window
let captured
globalThis.window = {
  __ModuleLoader__: {
    load: (handoff) => { captured = handoff },
  },
}

// 2. execute the bundle (new Function: runs in global scope, sees window)
new Function(readFileSync(bundlePath, 'utf8'))()
if (captured === undefined) throw new Error('bundle did not register via __ModuleLoader__.load')
if (captured.id !== 'dsh-plugin-manager') throw new Error(`unexpected bundle id: ${captured.id}`)

// 3. materialize with a module-table-mirroring require
// Anchor at a package that depends on react (the checkout root does not).
const checkoutRequire = createRequire(new URL(`file://${checkout}/packages/client/ui-primitives/package.json`))
const uiPrimitivesStub = { Modal: () => null, IconCordisPluginOutline14: () => null }
const moduleTable = new Map([
  ['react', checkoutRequire('react')],
  ['react/jsx-runtime', checkoutRequire('react/jsx-runtime')],
  ['@deepseek-ai/dsh-client-ui-primitives', uiPrimitivesStub],
])
const seen = new Set()
const exports = captured.factory((spec) => {
  seen.add(spec)
  if (!moduleTable.has(spec)) throw new Error(`require("${spec}") missed the module table (externals drift)`)
  return moduleTable.get(spec)
})

// 4. assert export shape
if (!Array.isArray(exports.inject) || exports.inject.join(',') !== 'slots,locale,remote') {
  throw new Error(`unexpected inject: ${JSON.stringify(exports.inject)}`)
}
if (typeof exports.apply !== 'function') throw new Error('apply is not exported')

// 5. assert apply mounts the installedPlugins contribution and registers the
//    dictionaries and the footer action
const calls = []
const registered = []
const remoteCalls = []
const mounted = []
const ctx = {
  effect: (fn, label) => { calls.push(['effect', label]); const disposer = fn(); if (typeof disposer === 'function') disposer() },
  locale: {
    register: (ns, dicts) => {
      calls.push(['locale.register', ns, Object.keys(dicts.zh ?? {}).length])
      return () => {}
    },
  },
  slots: {
    inject: (name, fn) => { calls.push(['slots.inject', name]); return fn() },
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
  },
  // The plugin reads the mounted namespace through ctx.get (the associative
  // `ctx.remote.installedPlugins` cannot resolve a service born on a sibling
  // fiber — that is exactly the runtime failure this test models).
  get: (name) => {
    if (name === 'remote.installedPlugins') {
      return {
        list: async () => {
          remoteCalls.push('installedPlugins.list')
          return { ok: true, value: { entries: [{ name: 'dsh-plugin-manager', enabled: true, fiberPhase: 'active', self: true }] } }
        },
        apply: async (changes) => {
          remoteCalls.push(`installedPlugins.apply:${JSON.stringify(changes)}`)
          return { ok: true, value: { needsReload: false, names: [] } }
        },
        discover: async () => {
          remoteCalls.push('installedPlugins.discover')
          return { ok: true, value: { plugins: [{ category: 'UI', name: 'owner/repo', url: 'https://github.com/owner/repo', summary: 's', spec: 'owner-repo' }] } }
        },
        installPlugin: async (spec) => {
          remoteCalls.push(`installedPlugins.installPlugin:${spec}`)
          return { ok: true, value: { needsRestart: true, name: spec } }
        },
        uninstall: async (spec) => {
          remoteCalls.push(`installedPlugins.uninstall:${spec}`)
          return { ok: true, value: { needsRestart: true, name: spec } }
        },
      }
    }
    return undefined
  },
  remote: {
    $mount: async (contribution) => {
      mounted.push(contribution)
      return async () => {}
    },
  },
}
await exports.apply(ctx)

// The plugin must mount its own installedPlugins contribution: the browser
// `remote` service never auto-discovers host Typert services, and the built-in
// assembly only mounts its own hard-coded contributions.
const mountedDescriptor = mounted.flatMap(c => c.descriptors ?? []).find(d => d.namespace === 'installedPlugins' && d.method === 'list')
if (mountedDescriptor === undefined) throw new Error('installedPlugins/list contribution was not mounted via ctx.remote.$mount')
if (mountedDescriptor.invocation?.kind !== 'direct') throw new Error(`unexpected invocation: ${JSON.stringify(mountedDescriptor.invocation)}`)
if (mountedDescriptor.result?.mode !== 'strict' || typeof mountedDescriptor.result?.schema?.parse !== 'function') {
  throw new Error('installedPlugins/list result codec is not strict with a parse() schema')
}

const applyDescriptor = mounted.flatMap(c => c.descriptors ?? []).find(d => d.namespace === 'installedPlugins' && d.method === 'apply')
if (applyDescriptor === undefined) throw new Error('installedPlugins/apply contribution was not mounted via ctx.remote.$mount')
if (applyDescriptor.invocation?.kind !== 'direct') throw new Error(`unexpected apply invocation: ${JSON.stringify(applyDescriptor.invocation)}`)
if (applyDescriptor.result?.mode !== 'strict' || typeof applyDescriptor.result?.schema?.parse !== 'function') {
  throw new Error('installedPlugins/apply result codec is not strict with a parse() schema')
}
const changesParam = applyDescriptor.parameters?.[0]
if (changesParam?.name !== 'changes' || changesParam?.wire !== 'changes' || changesParam?.codec?.mode !== 'strict' || typeof changesParam?.codec?.schema?.parse !== 'function') {
  throw new Error('installedPlugins/apply must declare a strict `changes` parameter codec')
}

const discoverDescriptor = mounted.flatMap(c => c.descriptors ?? []).find(d => d.namespace === 'installedPlugins' && d.method === 'discover')
if (discoverDescriptor === undefined) throw new Error('installedPlugins/discover contribution was not mounted via ctx.remote.$mount')
if (discoverDescriptor.result?.mode !== 'strict' || typeof discoverDescriptor.result?.schema?.parse !== 'function') {
  throw new Error('installedPlugins/discover result codec is not strict with a parse() schema')
}

const installDescriptor = mounted.flatMap(c => c.descriptors ?? []).find(d => d.namespace === 'installedPlugins' && d.method === 'installPlugin')
if (installDescriptor === undefined) throw new Error('installedPlugins/installPlugin contribution was not mounted via ctx.remote.$mount')
if (installDescriptor.result?.mode !== 'strict' || typeof installDescriptor.result?.schema?.parse !== 'function') {
  throw new Error('installedPlugins/installPlugin result codec is not strict with a parse() schema')
}
const installParam = installDescriptor.parameters?.[0]
if (installParam?.name !== 'spec' || installParam?.wire !== 'spec' || installParam?.codec?.mode !== 'strict') {
  throw new Error('installedPlugins/installPlugin must declare a strict `spec` parameter codec')
}

const restartDescriptor = mounted.flatMap(c => c.descriptors ?? []).find(d => d.namespace === 'installedPlugins' && d.method === 'uninstall')
if (restartDescriptor === undefined) throw new Error('installedPlugins/uninstall contribution was not mounted via ctx.remote.$mount')
if (restartDescriptor.result?.mode !== 'strict' || typeof restartDescriptor.result?.schema?.parse !== 'function') {
  throw new Error('installedPlugins/uninstall result codec is not strict with a parse() schema')
}
const uninstallParam = restartDescriptor.parameters?.[0]
if (uninstallParam?.name !== 'spec' || uninstallParam?.wire !== 'spec' || uninstallParam?.codec?.mode !== 'strict') {
  throw new Error('installedPlugins/uninstall must declare a strict `spec` parameter codec')
}

const registerCall = registered.find(r => r.options.name === 'sidebar.footer.action')
if (registerCall === undefined) throw new Error('no sidebar.footer.action registration')
if (registerCall.options.id !== 'plugin-manager') throw new Error(`unexpected action id: ${registerCall.options.id}`)
if (typeof registerCall.component !== 'function') throw new Error('action component is not a function')
if (!calls.some(([kind]) => kind === 'locale.register')) throw new Error('locale dictionary not registered')
// The injected business face must call the host remote through the reference
// the plugin captured with ctx.get after $mount.
const injected = registerCall.options.inject()
if (typeof injected.listInstalled !== 'function') throw new Error('listInstalled not injected')
await injected.listInstalled()
if (!remoteCalls.includes('installedPlugins.list')) throw new Error('listInstalled did not call the mounted installedPlugins service')
if (typeof injected.applyChanges !== 'function') throw new Error('applyChanges not injected')
await injected.applyChanges([{ name: 'dsh-plugin-manager', enabled: false }])
if (!remoteCalls.some(call => call.startsWith('installedPlugins.apply'))) throw new Error('applyChanges did not call the mounted installedPlugins/apply service')
if (typeof injected.discover !== 'function') throw new Error('discover not injected')
const discovered = await injected.discover()
if (!remoteCalls.includes('installedPlugins.discover')) throw new Error('discover did not call the mounted installedPlugins/discover service')
if (!Array.isArray(discovered) || discovered[0]?.spec !== 'owner-repo') throw new Error('discover did not return parsed plugin entries')
if (typeof injected.installPlugin !== 'function') throw new Error('installPlugin not injected')
await injected.installPlugin('owner-repo')
if (!remoteCalls.includes('installedPlugins.installPlugin:owner-repo')) throw new Error('installPlugin did not call the mounted installedPlugins/installPlugin service')
if (typeof injected.uninstall !== 'function') throw new Error('uninstall not injected')
await injected.uninstall('owner-repo')
if (!remoteCalls.includes('installedPlugins.uninstall:owner-repo')) throw new Error('uninstall did not call the mounted installedPlugins/uninstall service')

console.log('verify-client: PASS')
console.log(`  externals required: ${[...seen].join(', ')}`)
console.log(`  inject: ${JSON.stringify(exports.inject)}`)
console.log(`  mount: ${mountedDescriptor.namespace}/${mountedDescriptor.method} (${mountedDescriptor.result.mode})`)
console.log(`  mount: ${applyDescriptor.namespace}/${applyDescriptor.method} (${applyDescriptor.result.mode}, param ${changesParam.wire})`)
console.log(`  mount: ${discoverDescriptor.namespace}/${discoverDescriptor.method} (${discoverDescriptor.result.mode})`)
console.log(`  mount: ${installDescriptor.namespace}/${installDescriptor.method} (${installDescriptor.result.mode}, param ${installParam.wire})`)
console.log(`  mount: ${restartDescriptor.namespace}/${restartDescriptor.method} (${restartDescriptor.result.mode}, param ${uninstallParam.wire})`)
console.log(`  registration: ${registerCall.options.name} id=${registerCall.options.id} order=${registerCall.options.order}`)
console.log(`  remote: ${remoteCalls.join(', ')}`)
process.exit(0)
