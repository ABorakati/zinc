# Sample plugins

| Sample | Language | Shows |
|---|---|---|
| [`word-count`](word-count/) | Rust | an item list column, an item pane section (`ui-events`), and a preference (`plugin-ui`) |
| [`quick-tags`](quick-tags/) | JS (QuickJS) | an item context menu entry, a non-blocking dialog (`ui.dialog`), `library.apply`, a toast |
| [`highlight-export`](highlight-export/) | Rust | a reader toolbar button and an annotation context menu entry that export annotations to a note and show a toast |

Build one (output goes to `<dir>/dist`, or `--out`):

```bash
bun plugin-host/scripts/build-plugin.ts plugin-api/samples/word-count --out "$TEMP/zn-wasm-samples/word-count"
bun plugin-api/sdk/js/scripts/build.ts   plugin-api/samples/quick-tags --out "$TEMP/zn-wasm-samples/quick-tags"
```

Test all three (builds them, loads them through the supervisor with stub imports, checks what they register and do):

```bash
bun plugin-api/samples/test.ts [--only word-count] [--keep]
```

It needs more than 9 GiB free on the drive of `%TEMP%` for the Rust builds. The guide is
[`writing-a-plugin.md`](../../docs/developer-guide/wasm-plugins/writing-a-plugin.md).
