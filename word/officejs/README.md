# Zinc for Word, Office.js add-in

The same sidebar as the Windows COM add-in (`word/sidebar`), hosted in an Office.js task pane, so it runs where the COM add-in
cannot: Word for Mac and Word on the web (and Word for Windows too). The sidebar talks to its host through one interface,
`Host.call(method, params)` (`word/sidebar/src/host.ts`). The COM add-in answers those calls in C# (`word/addin/Bridge.cs`,
`WordDoc.cs`, `Library.cs`, `Styles.cs`, `Settings.cs`, `ZnClient.cs`). This package answers the same calls with Office.js.
`word/sidebar/src/mockhost.ts` is an in-memory copy of the whole contract: the reference for every method's params and result.

## Parts (each written separately; they meet only in `src/contracts.ts`)

| Folder | Part | Owns |
|---|---|---|
| `src/host`, `test/host` | Document host | every `doc.*` method |
| `src/format`, `test/format` | Result formatting | `ResultWriter`: citation text runs and bibliography paragraph format |
| `src/services`, `test/services` | Services | `host.info`, `settings.*`, `lib.*`, `style.*`, `locale.*`, `zn.*`, `app.openUrl` |
| `src/entry`, `test/entry`, `manifest`, `docs`, `build.ts`, `serve.ts` | Packaging | the task-pane entry that builds the Host from the parts and starts the sidebar, the build, the manifest, the local HTTPS dev server, install docs |

`src/contracts.ts` and `src/office-globals.d.ts` are shared: change them only by agreement (write the wish in your part's
`NOTES.md`).

## What testing in Word for Windows established (2026-11-20)

- **Fields stay the storage format** (Zotero-compatible `ADDIN ZOTERO_ITEM CSL_CITATION {json}` and `ADDIN ZOTERO_BIBL`), so
  documents move freely between Zotero, the COM add-in and this add-in.
- **Each Zotero field is wrapped in a rich-text content control tagged `ZINC <citationID>`** (bibliography: `ZINC bibl`).
  Zotero and the COM add-in still read the field inside. The wrapper gives a one-call lookup (`contentControls`) and the
  tracked-change check below. Wrap with Track Changes off. Unwrapped fields (documents from Zotero) must still work: wrap them
  on the first refresh.
- **Never ask Word for the tracked-change list** (`body.getTrackedChanges()`, or per range): it hangs Word for good in a
  document whose bibliography holds a tracked formatting change, and Office.js cannot time a call out.
- **Tracked insertions and deletions of citations**: `contentControls.getByChangeTrackingStates(["Added"])` / `(["Deleted"])`
  (WordApi 1.5) find them in one call (35 ms on a 44-citation manuscript). Fallback for unwrapped fields: the deleted field codes
  in `body.getOoxml()` (`w:delInstrText`; the body's XML includes the footnotes). A deleted citation is still listed in
  `body.fields`: skip it, so it leaves the numbering.
- **Every rewrite of an existing field with Track Changes off**: read `document.changeTrackingMode`, set `"Off"` in its own
  sync, write, and restore the user's mode in a `finally` in its own sync (a failed batch otherwise leaves tracking off). If the
  mode is still on after setting it off, tracking is locked (Lock Tracking): change nothing and say so, as the COM add-in does
  (`WordDoc.TrackingLockedMessage`). New and deleted citations stay tracked: those are the user's edits.
- **Footnote fields**: `.track()` every field (and its `result`) you will touch after the sync that listed it; untracked
  footnote field proxies fail with `ItemNotFound` in a later sync. Untrack at the end (`context.trackedObjects.remove`).
- **Read with** `body.fields.getByTypes(["Addin"])` (4.6 times faster than all fields in a document with 1,051 fields), plus
  each footnote's / endnote's `body.fields.getByTypes(["Addin"])`.
- **Write only what changed**, in chunks (Obiter uses 8-25 per sync): writes cost 16-300 ms per citation, 1.5-3 s per sync in
  a 300-footnote document.
- **A bibliography carrying tracked formatting** (left by older add-ins) is repaired by deleting its paragraphs whole (marks
  included, `getRange("Whole")` from first to last result paragraph) with Track Changes off and inserting a fresh paragraph and
  field (same code, same result). Rewriting the result or deleting only the field leaves it.

## Rules for everyone working here

- Work only in your own worktree and only inside your part's folders. Never delete, move or overwrite existing files, anywhere.
  No `rm`, `del`, `Remove-Item`, `git clean`, `git reset`, `git checkout -- <path>`, `git restore`, `git stash`, `git rebase`,
  `git branch -D`, `git worktree remove`, `git push`. If something outside your folders needs changing, write it in your part's
  `NOTES.md`.
- Bun only (no node, npm, npx; `bunx` is fine). Never `bun install`, `bun add` or `bun remove`: `node_modules` are junctions to
  the main checkout. No new dependencies.
- Never open `data/library.sqlite`, `C:\Users\abora\Zotero\*`, or ports 23119/23120.
- Never start Word or any window, and take no screenshots: the user works in a clinical system on this screen. Test with fakes
  of the Office.js objects you use; testing in Word happens later, by the coordinating session, with the user's permission.
- Typecheck with `bun check` (in `word/officejs`), test with `bun test`, format with `bun fmt`. Commit on your own branch only.
