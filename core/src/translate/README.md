# Zotero translators in zotero-next

Runs Zotero's own translators (the ones Zotero and translation-server use) without a browser.

- **Add from URL**: `POST /api/translate/web {url}` fetches the page, runs the matching web translator
  (`detectWeb` / `doWeb`), falls back to Embedded Metadata, then to a plain webpage item. A multi-item page answers
  `{choices}`; `POST /api/translate/web/select {session, keys}` saves the chosen ones.
- **Import**: `POST /api/translate/import {text | path}`. Formats `core/src/io` reads itself (RIS, BibTeX, CSL JSON,
  EndNote XML, PubMed nbib, Zotero RDF, MODS) go through the native importers first; anything else, or a native
  detection that finds nothing, goes through Zotero's import translators (`detectImport` / `doImport`).
- **Export**: `GET /api/translate/export-formats`, `POST /api/translate/export {translatorID, keys | collectionKey}`
  for every export translator (the natively exported formats are hidden from the list unless `?all=1`).
- `GET /api/translate/status` shows which translators folder is in use and how many translators of each type loaded.

Items are saved with `connector/items.ts` (`saveTranslatedItem`), so tags (automatic), notes, link attachments and
collections behave like connector saves; PDFs a translator lists are downloaded and stored as imported files.

The Zotero code lives in `core/vendor/zotero/`, which is git-ignored: after a fresh checkout run
`bun core/scripts/fetch-zotero-vendor.ts` (it downloads the pinned commits listed in that script).

## Layout

| Path | What |
|---|---|
| `api.ts`, `service.ts` | routes and use cases (saving, sessions for choice lists, native-first import) |
| `translators.ts` | which folder (env > `<data dir>/translators` > vendored), translator index, format lists |
| `update.ts`, `../../scripts/update-translators.ts` | refresh `<data dir>/translators` from GitHub (or a folder / tarball) |
| `pool.ts`, `worker.ts` | translation workers: one job at a time, hard timeout, worker replaced after a timeout or a failure |
| `runtime/` | the `Zotero` global the framework needs (zotero.ts), HTTP with caps (http.ts), jsdom + XPath (dom.ts), vm sandbox (sandbox.ts), the three jobs (jobs.ts) |

## Limits and sandbox

Translators run in a vm context with no `require`, `process`, `Bun`, `fetch` or dynamic `import()`, inside a worker
thread, with a per-run timeout (60 s), at most 25 HTTP requests, 10 MB per response (http/https only). This
contains accidents and casual abuse; it is not a hardened boundary, because objects handed to translators (documents,
utility functions) have host prototypes. Translators come from the vendored copy or the folder the updater writes, not
from the network at run time.

## NOTICE

The translators and translate/utilities frameworks vendored in `core/vendor/zotero/` are part of Zotero and licensed
under the GNU Affero General Public License v3 (https://www.gnu.org/licenses/agpl-3.0.html). The runtime in
`runtime/` is derived from zotero/translation-server (also AGPL-3.0). See `core/vendor/zotero/README.md` for the
upstream repositories and pinned commits.
