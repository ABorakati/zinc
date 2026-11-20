# `src/host` — Document Host Notes

## What Is Implemented

`createDocMethods(ctx, opts?)` (`src/host/index.ts`) implements all 19 `doc.*` bridge methods matching `word/addin/Bridge.cs` and `word/addin/WordDoc.cs`:

- **State & document targeting (`src/host/prefs.ts`)**: `doc.state` (`hasDoc`, `name`, `fullName`, `readOnly`, `prefsXml`, `protection`, `trackingLocked`), `doc.list`, `doc.target`, `doc.getPrefs`, `doc.setPrefs`, `doc.begin`, `doc.end`, `doc.save`.
  - Document preferences are stored in custom document properties `ZOTERO_PREF_1`..`ZOTERO_PREF_199` as 250-character slices of the raw `<data ...>` XML string (deleting stale tail properties on rewrite), matching `WordDoc.ReadPrefsXml` / `WordDoc.SetPrefs` so documents move between desktop Zotero, the Windows COM add-in, and Office.js unchanged.
- **Field scanning & session refs (`src/host/fields.ts`)**: `doc.fields` (`{ checkTracked }`) and `doc.signature`.
  - Reads `body.fields.getByTypes(["Addin"])` plus each footnote's and endnote's `note.body.fields.getByTypes(["Addin"])`.
  - Defines `idx` as the 1-based index in that story's `Addin` fields (`"main"`, `"fn"`, `"en"`), agreed upon across `doc.fields`, `doc.set`, `doc.setMany`, `doc.insert` (`after`), `doc.delete`, `doc.unlink`, `doc.convert`, `doc.select`, and `doc.cursor`; verifies `kind` and `cid` before writing (`CheckField`).
  - `.track()`s every `field`, `field.result`, `noteItem`, and `parentContentControlOrNullObject` accessed across `ctx.sync()` boundaries, and releases all tracked proxies in `finally`.
  - Computes per-story `start` / `end` spans from `Range.compareLocationWith` (`"AdjacentBefore"` -> touching, so `app.ts` `mergeAdjacent` merges touching citations and leaves separated ones apart) and interleaves footnote/endnote citations with main-body fields in reference-mark order.
- **Track Changes & Lock Tracking (`src/host/tracking.ts`)**:
  - Never calls `getTrackedChanges()`.
  - Uses `contentControls.getByChangeTrackingStates(["Deleted"])` / `(["Added"])` on each active body to skip tracked-deleted citations (matching by unique `ContentControl.id` so copy-pasted citations with identical `citationID` stay independent) and preserve user-added citations (`tracked: false`).
  - Falls back to `body.getOoxml()` (`w:delInstrText` vs `w:instrText`) for unwrapped Zotero fields and doubled/damaged codes.
  - Every rewrite of an existing field (`doc.set`, `doc.setMany`, `doc.unlink`, bibliography formatting on `doc.insert`, and wrap-on-refresh) switches `document.changeTrackingMode` to `"Off"` in its own `ctx.sync()`, verifies it turned off (throwing `WordDoc.TrackingLockedMessage` before writing anything if locked), writes, and restores the user's tracking mode in a `finally` in its own `ctx.sync()`.
  - `doc.insert`, `doc.set`, `doc.setMany`, `doc.delete`, `doc.unlink`, and `doc.convert` all refuse up front with `WordDoc.TrackingLockedMessage` when tracking is locked; user `insert` and `delete` otherwise keep Track Changes on.
- **Writes, chunking & bibliography repair (`src/host/writes.ts`)**:
  - New fields are created wrapper-first (`range.insertContentControl()` tagged `ZINC <citationID>` or `ZINC bibl` -> `cc.getRange("Content").insertField("Start", "Addin", codeWithoutAddin, true)` -> `resultWriter.queueResult`). Trailing `\* MERGEFORMAT` switches added by `insertField(..., true)` are stripped when reading `field.code` back so JSON parsing in `core/src/cite/docfields.ts` succeeds.
  - Unwrapped Zotero fields are wrapped with Track Changes off during refresh (`doc.fields({ checkTracked: true })` and `doc.set` / `doc.setMany`).
  - `doc.setMany` validates all target refs up front and writes normal updates in chunks of 25 fields per `ctx.sync()`, with constant non-chunk syncs.
  - Bibliographies carrying `w:pPrChange` or `w:rPrChange` in `body.getOoxml()` are flagged `tracked: true` in `doc.fields({ checkTracked: true })` and repaired on rewrite by stripping any outer wrapper (`keepContent = true`), inserting a fresh paragraph after `lastPara`, deleting `firstPara.getRange("Whole").expandTo(lastPara.getRange("Whole"))` (marks included) with Track Changes off, and inserting a fresh `ZINC bibl` wrapper + `Addin` field + result + bibliography format.
- **Cursor & `DocumentSelectionChanged` (`src/host/cursor.ts`)**:
  - `doc.cursor` takes a fast 1-sync path when the selection is outside citations and resolves `{ story, idx, kind, code, text }` for wrapped and unwrapped Zotero fields in main body, footnotes, and endnotes.
  - Registers `Office.EventType.DocumentSelectionChanged` via `Office.context.document.addHandlerAsync`, debounced (250 ms default) and deduplicated by cursor signature, emitting `"cursor"` via `ctx.emit`.
  - All `Word.run` operations are serialized on a per-host queue so background cursor reads can never interleave with `changeTrackingMode = "Off"` write windows.

## Untested in Real Word (Needs Verification in Word on Windows, Mac, and Web)

1. **`insertField("Start", "Addin", ..., true)` code round-trip**: Whether Word on Mac / Word on the web appends `\* MERGEFORMAT` or alters whitespace inside `field.code` differently from Word for Windows (our `normalizeFieldCode` strips `\* MERGEFORMAT` and trims).
2. **Wrapping unwrapped fields in footnotes via `field.select("Select")`**: Since `Word.Field` in WordApi 1.4/1.5 has no `.getRange()`, `wrapUnwrappedFields` selects each unwrapped field (`field.select("Select")`), calls `document.getSelection().insertContentControl()`, and restores the prior selection at the end of the sync. Needs testing on Word for Windows, Mac, and Web when an unwrapped Zotero citation lives inside a footnote while the footnote pane is closed.
3. **Probing `trackingLocked` via `changeTrackingMode`**: Office.js does not expose `Document.ProtectionType == wdAllowOnlyRevisions` directly. When `changeTrackingMode` is active, `probeTrackingLocked` toggles `changeTrackingMode = "Off"` and immediately restores the user's mode in `finally`. Needs verification in real Word whether toggling `changeTrackingMode` off/on without edits flips `document.saved` from `true` to `false` on a clean document under review.
4. **Bibliography whole-paragraph deletion at document boundaries**: `rebuildBibliographyParagraphs` inserts `freshPara` after `lastPara` before deleting `firstPara..lastPara` (`getRange("Whole")`) so Word never refuses deleting a body's sole final paragraph mark. Needs verification in real Word when a damaged bibliography sits inside a table cell or immediately before a section break.
5. **Unwrapped deleted fields in endnotes**: `README.md` notes `body.getOoxml()` includes footnotes; for unwrapped endnote fields we also inspect `endnote.body.getOoxml()`. Needs verification in Word on Mac/Web how `w:delInstrText` is serialized in `endnote.body.getOoxml()`.

## Open Questions

- **Multi-sync Undo grouping (`doc.begin` / `doc.end`)**: Office.js has no equivalent to COM's `Application.UndoRecord.StartCustomRecord`. A chunked `doc.setMany` or `withTrackingOff` sequence spans several `ctx.sync()` calls and therefore produces multiple entries on Word's Ctrl+Z stack.
- **Multi-document targeting (`doc.list` / `doc.target`)**: An Office.js task pane runs per document window and can only see its own `Office.context.document`, so `doc.list` always returns the single hosted document and `doc.target` accepts only `null` or that document's name/URL.

## Needs From Other Parts

- **`src/format` (`resultWriter`)**:
  - `queueResult(field, runs)` and `queueBibliographyFormat(field, fmt)` must only queue commands on `field.context` without calling `context.sync()` (so `doc.setMany`'s 25-field chunking and `withTrackingOff` control the sync boundaries).
  - Both are called after `src/host` has already switched `document.changeTrackingMode` to `"Off"` (except `doc.insert` of a new citation/bibliography, where the field + result insertion itself intentionally stays in the user's tracking mode and only `queueBibliographyFormat` runs with tracking off).
- **`src/entry`**:
  - Call `createDocMethods(ctx)` after `Office.onReady()` so `Office.context.document.addHandlerAsync(Office.EventType.DocumentSelectionChanged, ...)` is available when the cursor watcher subscribes.
  - No changes to `src/contracts.ts` or `src/office-globals.d.ts` are required.
