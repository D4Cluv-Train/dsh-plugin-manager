/**
 * Build the dsh bundles for @d4cluvtrain/dsh-plugin-manager: the browser client bundle and
 * the host remote-service module.
 *
 * Client bundle (`lib/client.js`) uses the dsh client-bundle format — the same
 * shape the in-repo `tsdown.client.ts` preset produces:
 *
 *   window.__ModuleLoader__.load({
 *     id: "@d4cluvtrain/dsh-plugin-manager",
 *     factory: (require) => { var module = { exports: {} }; ... return module.exports; }
 *   });
 *
 * Every specifier in CLIENT_EXTERNALS stays external and resolves at runtime
 * through the module loader's table (platform seed words + the runtime
 * `/client` exemption); everything else is bundled inline. CSS is plain text
 * injected by the plugin itself (no CSS-modules pipeline needed for this MVP).
 *
 * Host module (`lib/installed-plugins.js`) is the compiled form of
 * `src/host/installed-plugins.js`: esbuild lowers the `@Remote` decorator
 * syntax (Node cannot parse it natively) while keeping `@deepseek-ai/dsh-typert-protocol`
 * external — at runtime it resolves from the dsh installation closure
 * ($DSH_HOME/profiles/node_modules) and must be the SAME instance the Gateway
 * uses.
 *
 * Usage: npm run build   (esbuild is a devDependency)
 */
import { build } from 'esbuild'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * Mirror of the shell's PLATFORM_MODULES (packages/client/web/src/platform.ts)
 * plus the documented runtime `/client` exemption — the only specifiers the
 * loader's `require` can answer. Keep in sync with the seed table.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

// ── 1. browser client bundle ──────────────────────────────────────────────
const clientEntry = fileURLToPath(new URL('../src/client/index.jsx', import.meta.url))
const clientTmp = fileURLToPath(new URL('../lib/client.tmp.js', import.meta.url))
const clientOut = fileURLToPath(new URL('../lib/client.js', import.meta.url))

await build({
  entryPoints: [clientEntry],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  target: 'es2020',
  outfile: clientTmp,
  external: CLIENT_EXTERNALS,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})

const body = readFileSync(clientTmp, 'utf8')
const wrapped = [
  'window.__ModuleLoader__.load({',
  '\tid: "@d4cluvtrain/dsh-plugin-manager",',
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  body,
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n')
writeFileSync(clientOut, wrapped)
rmSync(clientTmp)
console.log(`build: wrote ${clientOut} (${wrapped.length} bytes)`)

// ── 2. host remote-service module ─────────────────────────────────────────
const hostOut = fileURLToPath(new URL('../lib/installed-plugins.js', import.meta.url))
await build({
  entryPoints: [fileURLToPath(new URL('../src/host/installed-plugins.js', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: hostOut,
  // Same-instance contract with the Gateway: never bundle the protocol.
  external: ['@deepseek-ai/dsh-typert-protocol'],
  logLevel: 'warning',
})
console.log(`build: wrote ${hostOut}`)
