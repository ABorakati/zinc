# quick-tags (JavaScript / QuickJS)

Right-click items, choose **Quick tags...**, type tags separated by commas, and they are added to all selected items.

| Extension point | Where in the code |
|---|---|
| `extend.register-menu` on `library-item` | `lifecycle.startup` |
| `extend-handlers.on-menu-command` | opens the dialog via `ui.dialog()` |
| `ui.open-dialog` with a JSON form (a text input named `tags`) and Cancel / OK | `dialog()`; `ui.dialog()` resolves when the dialog's `close` event arrives |
| `library.apply` with an `add-tags` change | `.then(...)` continuation of `ui.dialog()` |
| `ui.show-toast` | `.then(...)` continuation of `ui.dialog()` |

Permissions: `library.read`, `library.write`. Build: `bun plugin-api/sdk/js/scripts/build.ts plugin-api/samples/quick-tags` (it bundles the SDK
into one file, then calls `plugin-host/scripts/build-plugin.ts`). `definePlugin` supplies the 40-odd exports this plugin does not write.
