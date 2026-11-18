# quick-tags (JavaScript / QuickJS)

Right-click items, choose **Quick tags...**, type tags separated by commas, and they are added to all selected items.

| Extension point | Where in the code |
|---|---|
| `extend.register-menu` on `library-item` | `lifecycle.startup` |
| `extend-handlers.on-menu-command` | opens the dialog |
| `ui.run-dialog` with a form (a text input named `tags`) and Cancel / OK | `dialog()`; `ui.dialogSpec` converts the nested tree to the typed one a dialog needs |
| `library.apply` with an `add-tags` change | the same handler |
| `ui.show-toast` | the same handler |

Permissions: `library.read`, `library.write`. Build: `bun plugin-api/sdk/js/scripts/build.ts plugin-api/samples/quick-tags` (it bundles the SDK
into one file, then calls `plugin-host/scripts/build-plugin.ts`). `definePlugin` supplies the 40-odd exports this plugin does not write.
