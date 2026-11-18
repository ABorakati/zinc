# word-count (Rust)

Adds a **Words** column to the item list and a preference ("Count numbers as words").
The count comes from the indexed full text of the item's best attachment.

| Extension point | Where in the code |
|---|---|
| `extend.register-column` + `extend-handlers.on-column-values` | `startup`, `on_column_values` |
| `extend.register-pref-pane` with a toggle bound to the pref `countNumbers` | `startup` |
| `prefs.observe` + `events.on-pref-changed` | `on_pref_changed` clears the cache and invalidates the column |

World: `plugin-extend` (cargo feature `extend`); the pane section of the first version needed the Rust `ui` bindings, which do not compile yet.

Permissions: `library.read` (find the attachment), `library.fulltext.read`. Build: `bun plugin-host/scripts/build-plugin.ts plugin-api/samples/word-count`.
The pure function `count_words` has a unit test (`cargo test` runs it on the host).
