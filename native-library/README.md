# native-library

A native window for the zotero-next library, written with [MyGo](https://github.com/egoist/mygo)'s
native UI toolkit: the collections tree and the item table are drawn by MyGo itself (GPU, no web
view). PDFs open in tabs that share ONE web view showing the existing `reader-next` page (switching a
tab navigates it; the reader restores page, zoom and annotations). One view per tab was tried first
and measured 300-540 MB per tab on Windows, because each web view starts its own browser processes.

It is a client of the core service's HTTP API (`GET /api/collections`, `GET /api/items`), so it runs
beside the web UI against the same library. `core/` is unchanged.

```
go run .                       # needs core running on 127.0.0.1:23120 (ZN_URL overrides)
go test ./...                  # headless: fake core, no display, no GPU
SNAPSHOT_DIR=/tmp go test -run Snapshot   # PNGs of the window against a running core
GOOS=windows go build -ldflags="-s -w -H=windowsgui" -o zotero-next-library.exe .
```

Go 1.27.3 or newer (MyGo's requirement); `GOTOOLCHAIN=auto` fetches it. No cgo: the Windows and
macOS builds cross-compile from Linux.

## What it does

- Collections tree (nested, with counts) and My Library.
- Item table over the whole library: pages of 100 rows are fetched when their rows scroll into view;
  a header click sorts on the server; the search box queries `q=` after a 200 ms pause.
- Enter or double click on an item with an attachment opens it in a reader tab; the tabs share one web
  view, which navigates on tab switch and is destroyed when the last tab closes.

## Not done

- Item pane, tags, notes, saved searches, drag and drop, context menus, keyboard shortcuts.
- Reader tabs were not run: the web view needs WebView2 (Windows) or WebKitGTK, neither of which was
  available where this was built. The reader URL is the one the web UI's iframe uses.
- No memory comparison on Windows yet.
