# The go/no-go report

Write this for the user **before any port code**. The user decides what is worth porting; you cannot know which features they use. Keep it to one page. Start from the
output of `scripts/scan.ts`, then read the parity row of every `partial` and `not planned` pattern and the code around the hits (the scan is a regex pass: it cannot tell live
code from dead code, or a hit in the plugin's own XHTML pane from a hit on Zotero's DOM).

## Classify each feature, not each API call

List the plugin's user-visible features (from the README, the menus, the prefs, the locale strings), then place each in one bucket. A feature takes the worst status of the
APIs it needs.

| Bucket | Meaning | Typical members |
|---|---|---|
| **Ports cleanly** | every API it needs is covered | menus and submenus, item-list columns with text, prefs, notifier observers, library reads and batched writes, HTTP to a fixed list of hosts, Fluent strings, toasts, dialogs built from standard controls, annotations reads/writes, clipboard, timers |
| **Ports with changed behaviour** | partial rows, or a covered API used differently | blocking prompts become dialogs; per-row column provider becomes batched; DOM section becomes a ui tree; XUL pref pane becomes setting rows; `Zotero.DB` SQL becomes `library.*` queries (grouping limits); keyboard handling becomes named shortcuts; selection is a list (Zotero 10 multi-select); notifier sees host-recorded changes, not every internal event; one fixed attachment-resolver chain; numeric ids become keys |
| **Cannot be ported** | not planned and no extension point covers the intent | patches of Zotero internals, DOM edits of Zotero's own windows, restyling built-in UI, `_internalReader` / PDF.js DOM work with no typed equivalent, custom item types and fields, spawning processes or native messaging, WebSocket, raw SQL on tables Zinc does not model, access to other plugins' memory, changing Zotero's or Firefox's prefs, anything that needs a Zotero string table |
| **Unknown** | the code is dynamic (`eval`, computed `Zotero[x]`), minified, or depends on a library you have not read | say so; do not guess |

## Template (copy this structure)

```
# Port report: <Plugin name> <version> (<licence>)

Source: <xpi / repo + commit>. Targets Zotero <min> to <max> (Zinc ignores the max). Language: <JS|Rust> (<why, one line>).
Scan: <N> API patterns: <c> covered, <p> partial, <n> not planned. Bundled libraries: <list>.

## Recommendation
<GO / GO with cuts / NO-GO>, in one sentence: what the user gets and what they lose.

## Ports cleanly
- <feature>: <Zotero API> -> <Zinc call> (rows ...)

## Ports with changed behaviour
- <feature>: <what changes for the user, concretely>. <API> -> <Zinc>. (row ...)

## Cannot be ported
- <feature>: <the API or patch>, <why>, <nearest alternative if any, and what it would not do>.

## Needs from the user
- <decisions: ship without X? new status UI? which Zinc setting replaces pref Y?>

## Plan
- Permissions: <ids + one reason each>; net hosts: <list>.
- Order: 1. <smallest end-to-end slice> 2. ... Estimated size: <files / lines>.
- Verification: <what will be checked against the original behaviour>.
```

Rules for the report:

- **Name the behaviour, not the API.** "Pressing a number key sets the status" beats "keydown listener (extend row 111)". Put the row number in parentheses for whoever checks.
- **Say what the user loses**, in their terms, for every `partial` and `cannot` item. Never write "partial" without the consequence.
- **Check each claim against the row**, including "needs core" notes: a covered WIT function can still answer `unavailable` in the current core (`phase2-*.md`, "Stubbed or left"). Say "covered by the API, not yet implemented in the core" when that is the case.
- **Do not promise performance.** JS runs interpreted in QuickJS inside the component; library calls cross a process boundary.
- Include the **licence line** and the plan to keep notices (see `SKILL.md`, Licensing). If the licence is missing or restrictive (no licence, "all rights reserved", non-commercial), the verdict is **stop and ask**: do not copy code.
- If the Zinc side has a better native feature than the plugin (e.g. a built-in column or the host's shortcut settings), say that the right port may be "do nothing" or "configure Zinc".
- When the plugin is **already broken on Zotero 10** (singular selection getters, Bluebird helpers, `CookieSandbox`, `.jsm` imports; the scan flags them), say so: the original is not a valid reference for that part and the port follows the plural / modern behaviour.

## Choosing the language

| Choose | When |
|---|---|
| **JavaScript** (`plugin-api/sdk/js`, QuickJS) | default. The plugin is glue: menus, columns, prefs, notifier, library reads/writes, HTTP calls, small dialogs. Most of the original logic (string parsing, rules, API clients) can be kept almost verbatim, including pure npm libraries bundled by `build.ts` (Bun bundles them into the one file). Fast to build (seconds), no toolchain besides Bun. |
| **Rust** (`plugin-api/sdk/rust`) | the plugin is compute-heavy: text processing over whole libraries or full text, similarity / dedup, parsing large files, embeddings or hashing loops, big sorts. JS runs *interpreted* in QuickJS (no JIT), so tight loops over many thousands of items are slow; Rust compiles to native-speed wasm. Also when you want type safety on the UI trees, or a crate does the heavy lifting (regex, markdown, csv, zip, citation parsing). |
| **JS, then move the hot function to Rust later** | not possible inside one plugin: a plugin is one component in one language. Decide up front; if unsure, measure the original's hot loop (items x operations) before choosing. A plugin that processes 100 items interactively is a JS plugin; one that scans 100,000 items in the background is a Rust one. |

Cost of Rust: a `wasm32-wasip2` toolchain, longer builds (a release build takes 15-60 s the first time), a rewrite of the logic rather than a copy, and fewer ready-made libraries for
HTML/DOM-ish tasks. Cost of JS: speed on large loops, no threads (neither language has them in the guest), and the SDK's JSON-shaped records.

See `.claude/skills/zinc-plugin-create/` for project setup and builds in either language.
