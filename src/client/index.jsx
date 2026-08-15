/**
 * dsh-plugin-manager — browser client half.
 *
 * Registers a "插件" (Plugins) action into the sidebar's `sidebar.footer.action`
 * slot — the optional actions row rendered beside the Settings trigger at the
 * sidebar foot (declared by @deepseek-ai/dsh-client-ui-sidebar). Clicking the
 * button opens a modal that lists the plugins the user installed themselves
 * (via `dsh plugin --profile web add <pkg>`), fetched from the host-side
 * `installedPlugins` Typert remote (dsh-plugin-manager/installed-plugins).
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
const NS = 'pluginManager'

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
      throw new TypeError('installedPlugins/list result must be { entries: [...] }')
    }
    return {
      entries: value.entries.map(entry => ({
        name: String(entry?.name),
        enabled: Boolean(entry?.enabled),
        fiberPhase: entry?.fiberPhase ?? null,
        self: Boolean(entry?.self),
      })),
    }
  },
}

/** Strict codec for installedPlugins/apply parameters: `[{ name, enabled }]`. */
const applyChangesSchema = {
  parse(value) {
    if (!Array.isArray(value)) {
      throw new TypeError('installedPlugins/apply requires [{ name, enabled }]')
    }
    return value.map(change => ({
      name: String(change?.name),
      enabled: Boolean(change?.enabled),
    }))
  },
}

/** Strict codec for installedPlugins/apply result: `{ needsReload, names }`. */
const applyResultSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object') {
      throw new TypeError('installedPlugins/apply result must be an object')
    }
    return {
      needsReload: Boolean(value.needsReload),
      names: Array.isArray(value.names) ? value.names.map(name => String(name)) : [],
    }
  },
}

/** Strict codec for installedPlugins/install parameter: the package spec string. */
const installSpecSchema = {
  parse(value) { return String(value) },
}

/** Strict codec for installedPlugins/discover result: `{ plugins: [...] }`. */
const discoverResultSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || !Array.isArray(value.plugins)) {
      throw new TypeError('installedPlugins/discover result must be { plugins: [...] }')
    }
    return {
      plugins: value.plugins.map(plugin => ({
        category: plugin?.category ? String(plugin.category) : '',
        name: String(plugin?.name ?? ''),
        url: String(plugin?.url ?? ''),
        summary: plugin?.summary ? String(plugin.summary) : '',
        spec: String(plugin?.spec ?? ''),
      })),
    }
  },
}

/** Strict codec for installedPlugins/install result: `{ needsRestart, name }`. */
const installResultSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object') {
      throw new TypeError('installedPlugins/install result must be an object')
    }
    return {
      needsRestart: Boolean(value.needsRestart),
      name: String(value.name ?? ''),
    }
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
  package: 'dsh-plugin-manager',
  descriptors: [{
    id: 'dsh-plugin-manager#installedPlugins/list',
    service: 'installedPlugins',
    namespace: 'installedPlugins',
    method: 'list',
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol: 'dsh-plugin-manager#InstalledPluginsListResult',
      schema: listResultSchema,
    },
  }, {
    id: 'dsh-plugin-manager#installedPlugins/apply',
    service: 'installedPlugins',
    namespace: 'installedPlugins',
    method: 'apply',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'changes',
      wire: 'changes',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: 'dsh-plugin-manager#InstalledPluginsApplyChanges',
        schema: applyChangesSchema,
      },
    }],
    result: {
      mode: 'strict',
      typeSymbol: 'dsh-plugin-manager#InstalledPluginsApplyResult',
      schema: applyResultSchema,
    },
  }, {
    id: 'dsh-plugin-manager#installedPlugins/discover',
    service: 'installedPlugins',
    namespace: 'installedPlugins',
    method: 'discover',
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol: 'dsh-plugin-manager#InstalledPluginsDiscoverResult',
      schema: discoverResultSchema,
    },
  }, {
    id: 'dsh-plugin-manager#installedPlugins/installPlugin',
    service: 'installedPlugins',
    namespace: 'installedPlugins',
    method: 'installPlugin',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'spec',
      wire: 'spec',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: 'dsh-plugin-manager#InstalledPluginsInstallSpec',
        schema: installSpecSchema,
      },
    }],
    result: {
      mode: 'strict',
      typeSymbol: 'dsh-plugin-manager#InstalledPluginsInstallResult',
      schema: installResultSchema,
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
  'status.active': '运行中',
  'status.failed': '加载失败',
  'status.loading': '加载中',
  'status.disabled': '已关闭',
  'self.note': '管理器插件不可禁用',
  'apply.applying': '正在应用…',
  'apply.failed': '应用失败',
  'restart.title': '需要重启 dsh',
  'restart.message': '以下插件包含界面组件，需重启 dsh（或刷新页面）后生效：',
  'restart.reload': '立即刷新',
  'tab.installed': '已安装',
  'tab.discover': '发现',
  'discover.loading': '正在加载插件列表…',
  'discover.error': '加载插件列表失败',
  'discover.empty': '暂无可发现的插件',
  'discover.retry': '重试',
  'discover.install': '安装',
  'discover.installing': '安装中…',
  'discover.installed': '安装成功',
  'install.restart': '安装成功，需重启 dsh（或刷新页面）后生效',
  'install.failed': '安装失败',
}

/** English dictionary, checked complete against the zh key set. */
const en = {
  'label': 'Plugins',
  'dialog.title': 'Plugins',
  'dialog.loading': 'Loading installed plugins…',
  'dialog.empty': 'No user-installed plugins',
  'dialog.error': 'Failed to load the plugin list',
  'close': 'Close',
  'status.active': 'Running',
  'status.failed': 'Failed',
  'status.loading': 'Loading',
  'status.disabled': 'Disabled',
  'self.note': 'The manager plugin cannot be disabled',
  'apply.applying': 'Applying…',
  'apply.failed': 'Failed to apply',
  'restart.title': 'Restart required',
  'restart.message': 'These plugins include UI components and need a dsh restart (or page reload) to take effect:',
  'restart.reload': 'Reload now',
  'tab.installed': 'Installed',
  'tab.discover': 'Discover',
  'discover.loading': 'Loading plugin list…',
  'discover.error': 'Failed to load the plugin list',
  'discover.empty': 'No discoverable plugins',
  'discover.retry': 'Retry',
  'discover.install': 'Install',
  'discover.installing': 'Installing…',
  'discover.installed': 'Installed',
  'install.restart': 'Installed; needs a dsh restart (or page reload) to take effect',
  'install.failed': 'Install failed',
}

/**
 * Plugin-owned styles, injected once as a `<style data-plugin="dsh-plugin-manager">`
 * tag (the module loader claims and removes plugin-owned tags on unload). The
 * trigger row mirrors the Settings trigger rhythm (34px wide row / 36px rail
 * circle) using the shared design tokens.
 */
const CSS = `
.dsh-pm-modal {
  width: 60vw !important;
  max-width: 960px !important;
  min-width: 420px !important;
  height: 80vh !important;
}
.dsh-pm-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.dsh-pm-tabs {
  display: flex;
  gap: 4px;
  margin: 0;
  padding: 0 0 12px;
  border-bottom: 1px solid var(--dsw-alias-border-inverted);
}
.dsh-pm-tab {
  flex: none;
  border: none;
  background: transparent;
  padding: 6px 14px;
  border-radius: 8px;
  cursor: pointer;
  font-family: inherit;
  font-size: 14px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-pm-tab:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-pm-tab.active {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-pm-discover-item {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}
.dsh-pm-discover-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsh-pm-discover-name {
  flex: none;
  font-weight: 500;
}
.dsh-pm-discover-url {
  flex: 1;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  text-decoration: none;
  word-break: break-all;
}
.dsh-pm-discover-url:hover {
  text-decoration: underline;
  color: var(--dsw-alias-label-primary);
}
.dsh-pm-discover-summary {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}
.dsh-pm-discover-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dsh-pm-discover-command {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}
.dsh-pm-install-btn {
  flex: none;
  border: none;
  border-radius: 8px;
  padding: 5px 12px;
  cursor: pointer;
  background: var(--dsw-alias-accent, #4d6bfe);
  color: #fff;
  font-family: inherit;
  font-size: 13px;
  line-height: 18px;
}
.dsh-pm-install-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.dsh-pm-msg-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsh-pm-msg-row button {
  flex: none;
  border: none;
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
}
.dsh-pm-action {
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
.dsh-pm-action.wide {
  width: calc(100% + 8px);
  height: 34px;
  margin: 4px -4px 4px;
  padding: 6px 2px 6px 10px;
  border-radius: 12px;
}
.dsh-pm-action.rail {
  width: 36px;
  height: 36px;
  margin: 8px 0 10px;
  padding: 0;
  justify-content: center;
  border-radius: 50%;
}
.dsh-pm-action:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-pm-action-label {
  overflow: hidden;
  white-space: nowrap;
}
.dsh-pm-message {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}
.dsh-pm-error {
  margin: 0;
  color: var(--dsw-alias-label-danger);
  font-size: 13px;
  line-height: 20px;
}
.dsh-pm-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dsh-pm-item {
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
.dsh-pm-empty-note {
  margin: 12px 0 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-pm-item-name {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}
.dsh-pm-status {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  padding: 0 6px;
  border-radius: 6px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-pm-status--active {
  color: var(--dsw-alias-label-success, #22c55e);
}
.dsh-pm-status--failed {
  color: var(--dsw-alias-label-danger);
}
.dsh-pm-status--loading {
  color: var(--dsw-alias-label-tertiary);
}
.dsh-pm-status--disabled {
  color: var(--dsw-alias-label-tertiary);
}
.dsh-pm-self-note {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-pm-switch {
  appearance: none;
  -webkit-appearance: none;
  flex: none;
  width: 36px;
  height: 20px;
  margin: 0;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover);
  position: relative;
  cursor: pointer;
  transition: background 0.15s ease;
}
.dsh-pm-switch::before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-label-primary);
  transition: transform 0.15s ease;
}
.dsh-pm-switch:checked {
  background: var(--dsw-alias-accent, #4d6bfe);
}
.dsh-pm-switch:checked::before {
  transform: translateX(16px);
}
.dsh-pm-restart-actions {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dsh-pm-reload {
  border: none;
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
  background: var(--dsw-alias-accent, #4d6bfe);
  color: #fff;
  font-family: inherit;
  font-size: 14px;
  line-height: 20px;
}
`

let stylesInjected = false
/** Inject the plugin stylesheet once per page load. */
function ensureStyles() {
  if (stylesInjected || typeof document === 'undefined') return
  stylesInjected = true
  if (document.querySelector('style[data-plugin="dsh-plugin-manager"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-plugin-manager'
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/**
 * The sidebar footer action: a "插件" trigger row (icon + label when wide,
 * circle icon on the rail) opening a modal with two tabs — "已安装" lists
 * user-installed plugins with a status badge and enable/disable switch
 * (toggles staged locally, applied in ONE `installedPlugins/apply` call when
 * the modal closes), and "发现" lists plugins from the awesome-dsh-plugin
 * registry with one-click install.
 * @param props - `{ wide }` owner share from the sidebar shell, the locale
 * seat, and the `listInstalled`/`applyChanges`/`discover`/`installPlugin`
 * business faces injected at registration.
 */
function PluginManagerAction({ wide, t, listInstalled, applyChanges, discover, installPlugin }) {
  const [open, setOpen] = useState(false)
  // installed tab: phase 'idle' | 'loading' | 'ready' | 'error'
  const [state, setState] = useState({ phase: 'idle' })
  const [pending, setPending] = useState({})
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState(null)
  const [restart, setRestart] = useState(null)
  // tabs
  const [tab, setTab] = useState('installed')
  const [discoverState, setDiscoverState] = useState({ phase: 'idle' })
  const [installingSpec, setInstallingSpec] = useState(null)
  const [installResult, setInstallResult] = useState(null)

  const effectiveEnabled = (entry) =>
    Object.prototype.hasOwnProperty.call(pending, entry.name) ? pending[entry.name] : entry.enabled

  const openModal = () => {
    setOpen(true)
    setTab('installed')
    setState({ phase: 'loading' })
    setPending({})
    setApplyError(null)
    setInstallResult(null)
    listInstalled()
      .then(entries => { setState({ phase: 'ready', entries }) })
      .catch(error => { setState({ phase: 'error', error: String(error) }) })
  }

  const openDiscover = () => {
    setTab('discover')
    if (discoverState.phase === 'loading' || discoverState.phase === 'ready') return
    setDiscoverState({ phase: 'loading' })
    discover()
      .then(plugins => { setDiscoverState({ phase: 'ready', plugins }) })
      .catch(error => { setDiscoverState({ phase: 'error', error: String(error) }) })
  }

  const handleInstall = (spec) => {
    setInstallingSpec(spec)
    setInstallResult(null)
    installPlugin(spec)
      .then(result => setInstallResult({ ok: true, needsRestart: result.needsRestart, name: result.name }))
      .catch(error => setInstallResult({ ok: false, message: String(error) }))
      .finally(() => { setInstallingSpec(null) })
  }

  const close = () => {
    if (applying) return
    const changes = Object.entries(pending).map(([name, enabled]) => ({ name, enabled }))
    if (changes.length === 0) { setOpen(false); return }
    setApplying(true)
    setApplyError(null)
    applyChanges(changes)
      .then(async result => {
        const entries = await listInstalled()
        setState({ phase: 'ready', entries })
        setPending({})
        setOpen(false)
        if (result.needsReload && result.names.length > 0) setRestart({ names: result.names })
      })
      .catch(error => { setApplyError(String(error)) })
      .finally(() => { setApplying(false) })
  }

  const toggle = (name, enabled) => setPending(prev => ({ ...prev, [name]: enabled }))

  const statusOf = (entry, enabled) => {
    if (!enabled) return 'disabled'
    if (entry.fiberPhase === 'failed') return 'failed'
    if (entry.fiberPhase === 'active') return 'active'
    return 'loading'
  }

  return (
    <>
      <button
        type="button"
        className={`dsh-pm-action${wide ? ' wide' : ' rail'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('label')}
        onClick={openModal}
      >
        <IconCordisPluginOutline14 size={wide ? 14 : 18} />
        {wide && <span className="dsh-pm-action-label">{t('label')}</span>}
      </button>
      <Modal
        open={open}
        onClose={close}
        title={t('dialog.title')}
        closeLabel={t('close')}
        className="dsh-pm-modal"
        contentClassName="dsh-pm-content"
      >
        <div className="dsh-pm-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'installed'} className={`dsh-pm-tab${tab === 'installed' ? ' active' : ''}`} onClick={() => setTab('installed')}>{t('tab.installed')}</button>
          <button type="button" role="tab" aria-selected={tab === 'discover'} className={`dsh-pm-tab${tab === 'discover' ? ' active' : ''}`} onClick={openDiscover}>{t('tab.discover')}</button>
        </div>
        {tab === 'installed' && (
          <>
            {state.phase === 'loading' && <p className="dsh-pm-message">{t('dialog.loading')}</p>}
            {state.phase === 'error' && (
              <p className="dsh-pm-error">{t('dialog.error')}: {state.error}</p>
            )}
            {applyError !== null && (
              <p className="dsh-pm-error">{t('apply.failed')}: {applyError}</p>
            )}
            {state.phase === 'ready' && (state.entries.length === 0 ? (
              <>
                <p className="dsh-pm-message">{t('dialog.empty')}</p>
                <p className="dsh-pm-empty-note">dsh plugin --profile web add &lt;package&gt;</p>
              </>
            ) : (
              <ul className="dsh-pm-list">
                {state.entries.map(entry => {
                  const enabled = effectiveEnabled(entry)
                  const status = statusOf(entry, enabled)
                  return (
                    <li key={entry.name} className="dsh-pm-item">
                      <IconCordisPluginOutline14 size={14} />
                      <span className="dsh-pm-item-name">{entry.name}</span>
                      <span className={`dsh-pm-status dsh-pm-status--${status}`}>{t(`status.${status}`)}</span>
                      {entry.self ? (
                        <span className="dsh-pm-self-note">{t('self.note')}</span>
                      ) : (
                        <input
                          type="checkbox"
                          className="dsh-pm-switch"
                          checked={enabled}
                          aria-label={entry.name}
                          onChange={event => toggle(entry.name, event.target.checked)}
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            ))}
            {applying && <p className="dsh-pm-message">{t('apply.applying')}</p>}
          </>
        )}
        {tab === 'discover' && (
          <>
            {discoverState.phase === 'loading' && <p className="dsh-pm-message">{t('discover.loading')}</p>}
            {discoverState.phase === 'error' && (
              <div className="dsh-pm-msg-row">
                <p className="dsh-pm-error">{t('discover.error')}: {discoverState.error}</p>
                <button type="button" onClick={openDiscover}>{t('discover.retry')}</button>
              </div>
            )}
            {discoverState.phase === 'ready' && (discoverState.plugins.length === 0 ? (
              <p className="dsh-pm-message">{t('discover.empty')}</p>
            ) : (
              <ul className="dsh-pm-list">
                {discoverState.plugins.map(plugin => (
                  <li key={plugin.url} className="dsh-pm-item dsh-pm-discover-item">
                    <div className="dsh-pm-discover-head">
                      <IconCordisPluginOutline14 size={14} />
                      <span className="dsh-pm-discover-name">{plugin.name}</span>
                      <a className="dsh-pm-discover-url" href={plugin.url} target="_blank" rel="noreferrer">{plugin.url}</a>
                    </div>
                    {plugin.summary !== '' && <p className="dsh-pm-discover-summary">{plugin.summary}</p>}
                    <div className="dsh-pm-discover-actions">
                      <span className="dsh-pm-discover-command">dsh plugin --profile web add {plugin.spec}</span>
                      <button
                        type="button"
                        className="dsh-pm-install-btn"
                        disabled={installingSpec === plugin.spec}
                        onClick={() => handleInstall(plugin.spec)}
                      >
                        {installingSpec === plugin.spec ? t('discover.installing') : t('discover.install')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ))}
            {installResult !== null && (installResult.ok ? (
              <p className="dsh-pm-message">{installResult.needsRestart ? `${t('install.restart')}: ${installResult.name}` : `${t('discover.installed')}: ${installResult.name}`}</p>
            ) : (
              <p className="dsh-pm-error">{t('install.failed')}: {installResult.message}</p>
            ))}
          </>
        )}
      </Modal>
      <Modal
        open={restart !== null}
        onClose={() => setRestart(null)}
        title={t('restart.title')}
        closeLabel={t('close')}
      >
        <p className="dsh-pm-message">{t('restart.message')}</p>
        <ul className="dsh-pm-list">
          {(restart?.names ?? []).map(name => (
            <li key={name} className="dsh-pm-item"><span>{name}</span></li>
          ))}
        </ul>
        <div className="dsh-pm-restart-actions">
          <button
            type="button"
            className="dsh-pm-reload"
            onClick={() => window.location.reload()}
          >
            {t('restart.reload')}
          </button>
        </div>
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
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-manager: dictionaries')
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
    applyChanges: async (changes) => {
      const result = await installedPlugins.apply(changes)
      if (!result.ok) {
        throw new Error(`installedPlugins.apply failed: ${result.error.code}: ${result.error.message}`)
      }
      return result.value
    },
    discover: async () => {
      const result = await installedPlugins.discover()
      if (!result.ok) {
        throw new Error(`installedPlugins.discover failed: ${result.error.code}: ${result.error.message}`)
      }
      return result.value.plugins
    },
    installPlugin: async (spec) => {
      const result = await installedPlugins.installPlugin(spec)
      if (!result.ok) {
        throw new Error(`installedPlugins.installPlugin failed: ${result.error.code}: ${result.error.message}`)
      }
      return result.value
    },
  })
  ctx.effect(
    () => ctx.slots.inject('sidebar.footer.action', () =>
      ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'plugin-manager',
        order: 0,
        locale: NS,
        inject: injected,
        registrant: 'dsh-plugin-manager',
      }, PluginManagerAction)),
    'dsh-plugin-manager: sidebar footer action',
  )
}
