# Translators

Zinc runs Zotero's own translators, the ones Zotero and translation-server use, without a browser. They power "Add from URL", the import formats the app does not read natively, and the export formats. This page describes the runtime in `core/src/translate/` and the vendored Zotero code it runs.

## What it does

- Add from URL: `POST /api/translate/web {url}` fetches the page, runs the matching web translator (`detectWeb` then `doWeb`), falls back to Embedded Metadata, then to a plain webpage item. A page with several items answers `{choices}`; `POST /api/translate/web/select {session, keys}` saves the chosen ones.
- Import: `POST /api/translate/import {text | path}`. Formats that `core/src/io` reads itself (RIS, BibTeX, CSL JSON, EndNote XML, PubMed nbib, Zotero RDF, MODS) go through the native importers first. Anything else, or a native detection that finds nothing, goes through Zotero's import translators (`detectImport`, `doImport`).
- Export: `GET /api/translate/export-formats`, `POST /api/translate/export {translatorID, keys | collectionKey}` for every export translator. The natively exported formats are hidden from the list unless `?all=1`.
- `GET /api/translate/status` reports which translators folder is in use and how many translators of each type loaded.

Items are saved with `saveTranslatedItem` in `core/src/connector/items.ts`, so automatic tags, notes, link attachments and collections behave like connector saves. PDFs that a translator lists are downloaded and stored as imported files. The routes are summarised in [HTTP API](http-api.md).

## Code layout

| Path | What |
| --- | --- |
| `core/src/translate/api.ts`, `service.ts` | Routes and use cases (saving, sessions for choice lists, native-first import) |
| `core/src/translate/translators.ts` | Which folder is used, the translator index, format lists |
| `core/src/translate/update.ts`, `core/scripts/update-translators.ts` | Refresh a translators folder from GitHub, a folder or a tarball |
| `core/src/translate/pool.ts`, `worker.ts` | The worker pool |
| `core/src/translate/runtime/` | The `Zotero` global the framework needs (`zotero.ts`), HTTP with limits (`http.ts`), jsdom and XPath (`dom.ts`), the `vm` sandbox (`sandbox.ts`), the three jobs (`jobs.ts`) |
| `core/vendor/zotero/` | The vendored upstream code (git-ignored) |
| `gpui-ui/src/features/translate/` | The UI: web dialog, format lists, export |

## Vendored code

Everything in `core/vendor/zotero/` is Zotero's open-source translation code, pinned to commits. The folder is git-ignored. A fresh checkout fetches it with:

```
bun core/scripts/fetch-zotero-vendor.ts [--out <dir>] [--force]
```

The script downloads each upstream repository as a GitHub tarball at the commit in its `PINS` table, keeps only the files the runtime reads, and writes `core/vendor/zotero/README.md` with the notice. It does nothing if `translators/` already exists, unless you pass `--force`. CI caches the folder on the hash of the script, so changing a pin refreshes the cache.

| Folder | Upstream | Used for |
| --- | --- | --- |
| `translate/` | `zotero/translate` | The translation framework (`src/`) |
| `utilities/` | `zotero/utilities` | `Zotero.Utilities`, dates, item and field schema helpers |
| `translators/` | `zotero/translators` | The translators (`*.js`) |
| `zotero-schema/` | `zotero/zotero-schema` | `schema.json` (item types and fields) |
| `translation-server/` | `zotero/translation-server` | Reference only: `core/src/translate/runtime/` re-implements its wiring; only `COPYING` is kept |

The pinned commit hashes are in `PINS` in `core/scripts/fetch-zotero-vendor.ts`. To move the baseline, change them there and re-run the script with `--force`. `jsdom` and `wicked-good-xpath` (Zotero's fork, pinned in `core/package.json`) provide the DOM and XPath that translators expect.

## Choosing the translators folder

`translatorsDirFor(db)` in `translators.ts` picks, in order:

1. `ZN_TRANSLATORS_DIR`, if it holds `.js` files (`source: "env"`);
2. `<data dir>/translators`, where the data dir is the folder of the library database, if it holds translators (`source: "data"`);
3. the vendored `core/vendor/zotero/translators` (`source: "vendored"`). In the packaged app `ZN_ZOTERO_VENDOR` points at the `vendor/zotero` folder next to the exe.

Translators change often. To refresh the data-dir copy without moving the pinned baseline:

```
bun core/scripts/update-translators.ts [--data <data dir>] [--from <folder | tarball URL>]
```

It writes `<data dir>/translators` (default `$ZN_DATA_DIR`, else `<repo>/data`) from the `zotero/translators` tarball on GitHub, or from a local folder or another tarball for offline use, and refuses a source with fewer than 300 translators. It never touches `library.sqlite`. Pass an explicit `--data` pointing at a scratch folder when developing. Nothing in the app calls this at run time: translators come from the vendored copy or from this folder, never from the network while translating.

## Sandbox and limits

Translators run in a `vm` context with no `require`, `process`, `Bun`, `fetch` or dynamic `import()`, inside a worker thread:

| Limit | Value |
| --- | --- |
| Timeout per run | 60 s (`DEFAULT_TIMEOUT_MS` in `pool.ts`) |
| HTTP requests per run | 25 |
| Response size | 10 MB, http and https only |
| Workers | At most 2, one job at a time each |

The pool (`pool.ts`) replaces a worker after a timeout or a failure (translator code cannot be interrupted any other way) and recycles each worker after 50 jobs. This contains accidents and casual abuse. It is not a hardened security boundary: the objects handed to translators (documents, utility functions) have host prototypes.

In the packaged app the worker cannot ride inside the executable like the rest of the core, because jsdom and its companions are loaded by computed path. The non-AOT package ships a pre-bundled `translate-worker.js` (`gpui-ui/scripts/translate-worker.ts`); the AOT build compiles the worker and the framework in. See [Building](building.md).

## Environment variables

| Variable | Effect |
| --- | --- |
| `ZN_TRANSLATORS_DIR` | Use this translators folder instead of the data-dir and vendored copies |
| `ZN_ZOTERO_VENDOR` | Replaces the repo's `core/vendor/zotero` (set by the packaged app) |
| `ZN_TRANSLATE_WORKER` | Use a pre-bundled worker file (set by the packaged app) |
| `ZN_DATA_DIR` | Default data dir of `update-translators.ts` |

## Testing

Tests are in `core/test/translate/` (`translate.test.ts` calls the API; `update.test.ts` covers the updater). A few of them copy about 750 translator files, which is why the core suite runs with `--timeout 30000`; see [Testing](testing.md).

## Licence notice

The translators and the translate and utilities frameworks vendored in `core/vendor/zotero/` are part of Zotero and are licensed under the GNU Affero General Public License v3 (https://www.gnu.org/licenses/agpl-3.0.html). Zotero is Copyright (c) Corporation for Digital Scholarship, Vienna, Virginia, USA, and the Center for History and New Media, George Mason University. Individual translators carry their own authors and the AGPL header in each file. The `translators/` repository has no licence file of its own; the `COPYING` copied next to it is the AGPL text from `zotero/translate`.

The runtime in `core/src/translate/runtime/` is derived from `zotero/translation-server`, also AGPL-3.0. The vendored files are unmodified copies; Zinc's own glue code lives in `core/src/translate/` and is not part of the vendored sources. Distributing Zinc together with these files means complying with the AGPL for them, including source availability for network use and for the combined work. The packaged app ships the licence files and `vendor/zotero/README.md` for this reason.
