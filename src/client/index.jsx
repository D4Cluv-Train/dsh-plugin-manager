/**
 * dsh-hello-plugin — browser client half.
 *
 * Registers a "插件" (Plugins) action into the sidebar's `sidebar.footer.action`
 * slot — the optional actions row rendered beside the Settings trigger at the
 * sidebar foot (declared by @deepseek-ai/dsh-client-ui-sidebar). Clicking the
 * button opens a modal that lists the plugins the user installed themselves
 * (via `dsh plugin --profile web add <pkg>`), fetched from the host-side
 * `installedPlugins` Typert remote (dsh-hello-plugin/installed-plugins).
 * Shipped template bundles (dsh-base, dsh-web-app) are excluded by the host:
 * only `dsh.profile.bundles` entries that are also profile dependencies.
 *
 * The host half registers the `installedPlugins` Cordis service
 * (TypertRemoteService + @Remote), but the browser's `ctx.remote` does NOT
 * discover host services automatically — a client must mount a generated-style
 * Remote contribution through `ctx.remote.$mount()` to materialize the
 * `remote.installedPlugins` namespace. The built-in assembly
 * (@deepseek-ai/dsh-api-remotes) only mounts its own hard-coded contributions,
 * so this bundle mounts its own here: `apply` awaits
 * `ctx.remote.$mount(INSTALLED_PLUGINS_REMOTE)` and only then registers the
 * UI. Consequently `remote.installedPlugins` is created by this plugin itself
 * and must NOT appear in `inject` (it would pend forever waiting for a service
 * that is only born during this plugin's own apply). Because that service is
 * provided on the gateway's fiber — a sibling of this plugin's fiber — the
 * associative `ctx.remote.installedPlugins` access cannot resolve it (it only
 * walks this fiber's parent chain and throws "without inject"); `apply`
 * instead captures the live reference with `ctx.get('remote.installedPlugins')`
 * (shared root store) and injects it into the modal face.
 *
 * Bundle contract: this file is compiled by `npm run build` into
 * `lib/client.js` in the dsh client-bundle format
 * (`window.__ModuleLoader__.load({ id, factory })`); every import below that is
 * not a platform-module word stays external and resolves through the loader's
 * module table at runtime. The host halves (lib/plugin.mjs,
 * lib/installed-plugins.js) and this bundle ship in the same package, so
 * `dsh plugin --profile web add <pkg>` brings all of them.
 */

import { useState } from 'react'
import {
  IconCordisPluginOutline14,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Cordis services required before apply (all provided by shell client plugins). */
export const inject = ['slots', 'locale', 'remote']

/** Locale namespace owned by this plugin (the register() `locale` seat). */
const NS = 'helloPlugin'

/**
 * Strict result codec for `installedPlugins/list`. The client-side Gateway
 * requires every mounted descriptor to carry a `mode: 'strict'` codec whose
 * `schema.parse()` validates and normalizes the payload — the same contract a
 * generated `/remote` artifact meets with Zod. Hand-written here because this
 * plugin ships no generated Typert face: the wire value is
 * `{ entries: [{ name }] }` (host InstalledPluginsGateway.list).
 */
const listResultSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || !Array.isArray(value.entries)) {
      throw new TypeError('installedPlugins/list result must be { entries: [{ name }] }')
    }
    return { entries: value.entries.map(entry => ({ name: String(entry?.name) })) }
  },
}

/**
 * The client-side Typert Remote contribution that materializes the
 * `remote.installedPlugins` namespace. It mirrors the host binding
 * (`TypertRemoteService(ctx, 'installedPlugins')` + `@Remote('list')`) so the
 * Gateway routes `installedPlugins/list` RPCs to the host gateway, and it is
 * what `apply` mounts through `ctx.remote.$mount()`.
 */
const INSTALLED_PLUGINS_REMOTE = {
  package: 'dsh-hello-plugin',
  descriptors: [{
    id: 'dsh-hello-plugin#installedPlugins/list',
    service: 'installedPlugins',
    namespace: 'installedPlugins',
    method: 'list',
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol: 'dsh-hello-plugin#InstalledPluginsListResult',
      schema: listResultSchema,
    },
  }],
}

/** Simplified Chinese dictionary (the key-set source of truth). */
const zh = {
  'label': '插件',
  'dialog.title': '插件',
  'dialog.loading': '正在加载已安装插件…',
  'dialog.empty': '暂无自行安装的插件',
  'dialog.error': '加载插件列表失败',
  'close': '关闭',
}

/** English dictionary, checked complete against the zh key set. */
const en = {
  'label': 'Plugins',
  'dialog.title': 'Plugins',
  'dialog.loading': 'Loading installed plugins…',
  'dialog.empty': 'No user-installed plugins',
  'dialog.error': 'Failed to load the plugin list',
  'close': 'Close',
}

/**
 * Plugin-owned styles, injected once as a `<style data-plugin="dsh-hello-plugin">`
 * tag (the module loader claims and removes plugin-owned tags on unload). The
 * trigger row mirrors the Settings trigger rhythm (34px wide row / 36px rail
 * circle) using the shared design tokens.
 */
const CSS = `
.dsh-hello-action {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  border: none;
  background: transparent;
  cursor: pointer;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
}
.dsh-hello-action.wide {
  width: calc(100% + 8px);
  height: 34px;
  margin: 4px -4px 4px;
  padding: 6px 2px 6px 10px;
  border-radius: 12px;
}
.dsh-hello-action.rail {
  width: 36px;
  height: 36px;
  margin: 8px 0 10px;
  padding: 0;
  justify-content: center;
  border-radius: 50%;
}
.dsh-hello-action:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-hello-action-label {
  overflow: hidden;
  white-space: nowrap;
}
.dsh-hello-message {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}
.dsh-hello-error {
  margin: 0;
  color: var(--dsw-alias-label-danger);
  font-size: 13px;
  line-height: 20px;
}
.dsh-hello-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dsh-hello-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 20px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}
.dsh-hello-empty-note {
  margin: 12px 0 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
`

let stylesInjected = false
/** Inject the plugin stylesheet once per page load. */
function ensureStyles() {
  if (stylesInjected || typeof document === 'undefined') return
  stylesInjected = true
  if (document.querySelector('style[data-plugin="dsh-hello-plugin"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-hello-plugin'
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/**
 * The sidebar footer action: a "插件" trigger row (icon + label when wide,
 * circle icon on the rail) opening a modal listing user-installed plugins.
 * @param props - `{ wide }` owner share from the sidebar shell, the locale
 * seat, and the `listInstalled` business face injected at registration.
 */
function HelloPluginAction({ wide, t, listInstalled }) {
  const [open, setOpen] = useState(false)
  // phase: 'idle' | 'loading' | 'ready' | 'error'
  const [state, setState] = useState({ phase: 'idle' })
  const close = () => { setOpen(false) }
  const openModal = () => {
    setOpen(true)
    setState({ phase: 'loading' })
    listInstalled()
      .then(entries => { setState({ phase: 'ready', entries }) })
      .catch(error => { setState({ phase: 'error', error: String(error) }) })
  }
  return (
    <>
      <button
        type="button"
        className={`dsh-hello-action${wide ? ' wide' : ' rail'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('label')}
        onClick={openModal}
      >
        <IconCordisPluginOutline14 size={wide ? 14 : 18} />
        {wide && <span className="dsh-hello-action-label">{t('label')}</span>}
      </button>
      <Modal
        open={open}
        onClose={close}
        title={t('dialog.title')}
        closeLabel={t('close')}
      >
        {state.phase === 'loading' && <p className="dsh-hello-message">{t('dialog.loading')}</p>}
        {state.phase === 'error' && (
          <p className="dsh-hello-error">{t('dialog.error')}: {state.error}</p>
        )}
        {state.phase === 'ready' && (state.entries.length === 0 ? (
          <>
            <p className="dsh-hello-message">{t('dialog.empty')}</p>
            <p className="dsh-hello-empty-note">dsh plugin --profile web add &lt;package&gt;</p>
          </>
        ) : (
          <ul className="dsh-hello-list">
            {state.entries.map(entry => (
              <li key={entry.name} className="dsh-hello-item">
                <IconCordisPluginOutline14 size={14} />
                <span>{entry.name}</span>
              </li>
            ))}
          </ul>
        ))}
      </Modal>
    </>
  )
}

/**
 * Register the installedPlugins Remote, the dictionaries, and the sidebar
 * footer action. The Remote mount runs first because it is what births the
 * `remote.installedPlugins` namespace the modal queries — a service this
 * plugin owns, so it cannot be a cordis inject dependency. The action itself
 * waits for the sidebar's slot declaration through `slots.inject`, so this
 * bundle applies even if the sidebar mounts later.
 * @param ctx - client root context.
 */
export async function apply(ctx) {
  ensureStyles()
  await ctx.remote.$mount(INSTALLED_PLUGINS_REMOTE)
  // The namespace service is registered by $mount on the gateway's fiber, a
  // sibling of this plugin's fiber. Cordis's `ctx.remote.installedPlugins`
  // associative access walks only THIS fiber's parent chain, so it cannot see
  // a service born on a sibling — it throws "without inject". `ctx.get` reads
  // the shared root store instead, so grab the live reference here and bind it
  // into the injected face. (Declaring it in `inject` is impossible: the
  // service only exists after this plugin's own $mount runs.)
  const installedPlugins = ctx.get('remote.installedPlugins')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-hello-plugin: dictionaries')
  const injected = () => ({
    listInstalled: async () => {
      const result = await installedPlugins.list()
      if (!result.ok) {
        throw new Error(`installedPlugins.list failed: ${result.error.code}: ${result.error.message}`)
      }
      // The host gateway surface returns `{ entries, error? }`: a profile read
      // failure is carried inside the payload rather than the RPC envelope.
      if (result.value.error) {
        throw new Error(`installedPlugins.list failed: ${result.value.error}`)
      }
      return result.value.entries
    },
  })
  ctx.effect(
    () => ctx.slots.inject('sidebar.footer.action', () =>
      ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'hello-plugin',
        order: 0,
        locale: NS,
        inject: injected,
        registrant: 'dsh-hello-plugin',
      }, HelloPluginAction)),
    'dsh-hello-plugin: sidebar footer action',
  )
}
