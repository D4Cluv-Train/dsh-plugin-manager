/**
 * Build the dsh client bundle for dsh-hello-plugin.
 *
 * Emits `lib/client.js` in the dsh client-bundle format — the same shape the
 * in-repo `tsdown.client.ts` preset produces:
 *
 *   window.__ModuleLoader__.load({
 *     id: "dsh-hello-plugin",
 *     factory: (require) => { var module = { exports: {} }; ... return module.exports; }
 *   });
 *
 * Every specifier in EXTERNALS stays external and resolves at runtime through
 * the module loader's table (platform seed words + the runtime `/client`
 * exemption); everything else is bundled inline. CSS is plain text injected by
 * the plugin itself (no CSS-modules pipeline needed for this MVP).
 *
 * Usage: npm run build:client   (esbuild is a devDependency)
 */
import { build } from 'esbuild'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const entry = fileURLToPath(new URL('../src/client/index.jsx', import.meta.url))
const tmp = fileURLToPath(new URL('../lib/client.tmp.js', import.meta.url))
const out = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/**
 * Mirror of the shell's PLATFORM_MODULES (packages/client/web/src/platform.ts)
 * plus the documented runtime `/client` exemption — the only specifiers the
 * loader's `require` can answer. Keep in sync with the seed table.
 */
const EXTERNALS = [
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

await build({
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  target: 'es2020',
  outfile: tmp,
  external: EXTERNALS,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'warning',
})

const body = readFileSync(tmp, 'utf8')
const wrapped = [
  'window.__ModuleLoader__.load({',
  '\tid: "dsh-hello-plugin",',
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
writeFileSync(out, wrapped)
rmSync(tmp)
console.log(`build:client: wrote ${out} (${wrapped.length} bytes)`)
