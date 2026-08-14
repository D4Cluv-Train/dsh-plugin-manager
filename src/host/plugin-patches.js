/**
 * dsh-hello-plugin — profile `cordis.patch.yml` merge read/write helpers.
 *
 * The profile's own `cordis.patch.yml` is the user-override patch layer: it is
 * applied AFTER every bundle patch (later rows win per entry id) and is
 * hot-reloaded by the boot HMR watcher (`watchUserPatches`). The enable/disable
 * feature persists its toggles as id-targeted `{ id, disabled: true }` rows in
 * that file, so host-side entries are live-disposed/re-enabled on write.
 *
 * Ownership contract ("managed rows"): a row is managed by this module iff
 *   - `id` is a self-installed bundle's entry id (passed in by the caller), AND
 *   - it has NO `insert` / `name` / `config` / `group` fields, AND
 *   - `disabled` is a plain boolean.
 * Every other row — user-authored inserts, `!!js` expressions, config
 * overrides — is preserved verbatim. The YAML dialect mirrors the include
 * package's `entryListSchema` (JSON schema + a `!!js` passthrough type) so
 * user-written `!!js` scalars round-trip instead of being lost.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import yaml from 'js-yaml'

/** `!!js` scalar type, identical to the include package's `JsExpr` definition. */
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: (data) =>
    data !== null && typeof data === 'object' && typeof data.__jsExpr === 'string',
  represent: (data) => data.__jsExpr,
})

const SCHEMA = yaml.JSON_SCHEMA.extend(JsExpr)

const RETRYABLE = new Set(['EACCES', 'EBUSY', 'EPERM'])
const WRITE_RETRY_LIMIT = 10
const WRITE_RETRY_DELAY_MS = 50

async function withRetry(fn) {
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (error) {
      if (!RETRYABLE.has(error?.code) || attempt >= WRITE_RETRY_LIMIT) throw error
      attempt += 1
      await new Promise((resolve) => setTimeout(resolve, WRITE_RETRY_DELAY_MS))
    }
  }
}

/**
 * Read a patch list file as an array of patch rows. A missing file is "no
 * layer" (empty array); an unparsable or non-array file throws (misconfiguration
 * must not be silently overwritten).
 * @param file - absolute path of the patch file.
 * @returns parsed patch rows.
 */
export async function readPatchRows(file) {
  let content
  try {
    content = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  if (content.trim() === '') return []
  const parsed = yaml.load(content, { schema: SCHEMA })
  if (parsed === null || parsed === undefined) return []
  if (!Array.isArray(parsed)) {
    throw new Error(`patch file ${file} must be a top-level YAML array`)
  }
  return parsed
}

/**
 * Whether a patch row is owned ("managed") by this module for one of the given
 * entry ids: a bare `{ id, disabled: <boolean> }` override targeting that id.
 * @param row - one parsed patch row.
 * @param ids - set of entry ids currently under management.
 */
export function isManagedDisabledRow(row, ids) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return false
  if (typeof row.id !== 'string' || !ids.has(row.id)) return false
  if (
    row.insert !== undefined
    || row.name !== undefined
    || row.config !== undefined
    || row.group !== undefined
  ) return false
  return typeof row.disabled === 'boolean'
}

/**
 * Atomically write a patch list: serialize, write a temp file, rename over the
 * target (the HMR watcher observes the parent directory via chokidar, so a
 * rename is reliably detected as a change). Retried on transient lock errors.
 * @param file - absolute path of the patch file.
 * @param rows - full patch list to persist.
 */
export async function writePatchRows(file, rows) {
  const body = yaml.dump(rows, { schema: SCHEMA, lineWidth: -1 })
  const tmp = `${file}.tmp`
  await withRetry(() => writeFile(tmp, body, 'utf8'))
  await withRetry(() => rename(tmp, file))
}

/**
 * Apply enable/disable changes to the patch file. For each entry id: when
 * `disable` is true a `{ id, disabled: true }` row is added; otherwise any
 * managed disabled row for that id is removed. Unrelated rows are preserved.
 * @param file - absolute path of the patch file.
 * @param changesById - Map of entry id → boolean (true = disable).
 * @returns the resulting patch list (post-write).
 */
export async function applyEnabledChanges(file, changesById) {
  const rows = await readPatchRows(file)
  const ids = new Set(changesById.keys())
  const kept = rows.filter((row) => !isManagedDisabledRow(row, ids))
  for (const [id, disable] of changesById) {
    if (disable) kept.push({ id, disabled: true })
  }
  await writePatchRows(file, kept)
  return kept
}
