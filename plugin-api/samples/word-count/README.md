# word-count (Rust)

Adds a **Words** column to the item list, a **Word Count** section in the item pane, and a preference ("Count numbers as words").
The count comes from the indexed full text of the item's best attachment.

| Extension point | Where in the code |
|---|---|
| `extend.register-column` + `extend-handlers.on-column-values` | `startup`, `on_column_values` |
| `extend.register-section` + `ui-events.mount` / `update-context` / `on-event` | `startup`, `mount`, `update_context`, `on_ui_event` |
| `extend.register-pref-pane` with a toggle bound to the pref `countNumbers` | `startup` |
| `prefs.observe` + `events.on-pref-changed` | `on_pref_changed` clears the cache, invalidates the column, and refreshes mounted sections |

World: `plugin-ui` (cargo feature `ui`).

Permissions: `library.read` (find the attachment), `library.fulltext.read`. Build: `bun plugin-host/scripts/build-plugin.ts plugin-api/samples/word-count`.
The pure function `count_words` has a unit test (`cargo test` runs it on the host).
