/**
 * dsh-hello-plugin — browser client half.
 *
 * Registers a "插件" (Plugins) action into the sidebar's `sidebar.footer.action`
 * slot — the optional actions row rendered beside the Settings trigger at the
 * sidebar foot (declared by @deepseek-ai/dsh-client-ui-sidebar). Clicking the
 * button opens a centered empty modal (`Modal` from the shared primitives).
 *
 * Bundle contract: this file is compiled by `scripts/build-client.mjs` into
 * `lib/client.js` in the dsh client-bundle format
 * (`window.__ModuleLoader__.load({ id, factory })`); every import below that is
 * not a platform-module word stays external and resolves through the loader's
 * module table at runtime. The host half (lib/plugin.mjs) and this bundle ship
 * in the same package, so `dsh plugin --profile web add <pkg>` brings both.
 */

import { useState } from 'react'
import {
  IconCordisPluginOutline14,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Cordis services required before apply (both provided by shell client plugins). */
export const inject = ['slots', 'locale']

/** Locale namespace owned by this plugin (the register() `locale` seat). */
const NS = 'helloPlugin'

/** Simplified Chinese dictionary (the key-set source of truth). */
const zh = {
  'label': '插件',
  'dialog.title': '插件',
  'dialog.empty': '这里将展示插件内容（占位）。dsh-hello-plugin 已加载。',
  'close': '关闭',
}

/** English dictionary, checked complete against the zh key set. */
const en = {
  'label': 'Plugins',
  'dialog.title': 'Plugins',
  'dialog.empty': 'Plugin content goes here (placeholder). dsh-hello-plugin is loaded.',
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
.dsh-hello-empty {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
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
 * circle icon on the rail) opening an empty modal.
 * @param props - `{ wide }` owner share from the sidebar shell plus the
 * locale seat synthesized from the register() `locale` option.
 */
function HelloPluginAction({ wide, t }) {
  const [open, setOpen] = useState(false)
  const close = () => { setOpen(false) }
  return (
    <>
      <button
        type="button"
        className={`dsh-hello-action${wide ? ' wide' : ' rail'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('label')}
        onClick={() => { setOpen(true) }}
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
        <p className="dsh-hello-empty">{t('dialog.empty')}</p>
      </Modal>
    </>
  )
}

/**
 * Register the dictionaries and the sidebar footer action. The action waits
 * for the sidebar's slot declaration through `slots.inject`, so this bundle
 * applies even if the sidebar mounts later.
 * @param ctx - client root context.
 */
export function apply(ctx) {
  ensureStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-hello-plugin: dictionaries')
  ctx.effect(
    () => ctx.slots.inject('sidebar.footer.action', () =>
      ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'hello-plugin',
        order: 0,
        locale: NS,
        registrant: 'dsh-hello-plugin',
      }, HelloPluginAction)),
    'dsh-hello-plugin: sidebar footer action',
  )
}
