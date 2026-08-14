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
const checkout = process.env.DSH_CHECKOUT ?? '/Users/gswl00001/Me/DeepSeekHarness/deepseek-harness'
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
if (captured.id !== 'dsh-hello-plugin') throw new Error(`unexpected bundle id: ${captured.id}`)

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
  remote: {
    $mount: async (contribution) => {
      mounted.push(contribution)
      return async () => {}
    },
    installedPlugins: {
      list: async () => {
        remoteCalls.push('installedPlugins.list')
        return { ok: true, value: { entries: [{ name: 'dsh-hello-plugin' }] } }
      },
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

const registerCall = registered.find(r => r.options.name === 'sidebar.footer.action')
if (registerCall === undefined) throw new Error('no sidebar.footer.action registration')
if (registerCall.options.id !== 'hello-plugin') throw new Error(`unexpected action id: ${registerCall.options.id}`)
if (typeof registerCall.component !== 'function') throw new Error('action component is not a function')
if (!calls.some(([kind]) => kind === 'locale.register')) throw new Error('locale dictionary not registered')
// The injected business face must call the host remote through ctx.remote.
const injected = registerCall.options.inject()
if (typeof injected.listInstalled !== 'function') throw new Error('listInstalled not injected')
await injected.listInstalled()
if (!remoteCalls.includes('installedPlugins.list')) throw new Error('listInstalled did not call ctx.remote.installedPlugins.list')

console.log('verify-client: PASS')
console.log(`  externals required: ${[...seen].join(', ')}`)
console.log(`  inject: ${JSON.stringify(exports.inject)}`)
console.log(`  mount: ${mountedDescriptor.namespace}/${mountedDescriptor.method} (${mountedDescriptor.result.mode})`)
console.log(`  registration: ${registerCall.options.name} id=${registerCall.options.id} order=${registerCall.options.order}`)
console.log(`  remote: ${remoteCalls.join(', ')}`)
process.exit(0)
