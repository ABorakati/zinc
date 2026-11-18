# highlight-export (Rust)

Two entry points in the PDF/EPUB reader:

- a toolbar button **Export highlights to note**: all highlights and underlines of the open file become one note under the parent item,
- an annotation context menu entry **Export to note**: the annotations the menu was opened on.

| Extension point | Where in the code |
|---|---|
| `reader.register-listener` with target `slot(toolbar)` and a static menu entry | `startup` |
| `reader.register-listener` with target `menu(annotation)` | `startup` |
| `reader-events.on-menu-command` (the SDK names it `on_reader_menu_command`) | dispatches on listener id and command |
| `annotations.list-annotations`, `library.apply` (`create-item`, a note as HTML) | `export` |
| `log.write` | the result (a toast needs the Rust `ui` bindings, which do not compile yet) |

Permissions: `reader.ui`, `annotations.read`, `library.write`. Build: `bun plugin-host/scripts/build-plugin.ts plugin-api/samples/highlight-export`.
