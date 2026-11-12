# Notes and web tabs

## Notes

An item can have any number of **child notes**, and you can also keep **standalone notes** that belong to no item. Notes are stored as HTML in the Zotero note format, so they open in Zotero unchanged.

### Creating notes

| Where | How |
|---|---|
| Child note | Select the item and click the **+** (**Add Note**) in the **Notes** section of the item pane, or right-click the item and choose **Add Note**. |
| Standalone note | **Add > New Standalone Note**. The note is created in the collection you have selected. |
| From annotations | In the [reader](reader.md), **Add note from annotations** in the Annotations panel adds a child note that lists the annotations. |

### The note editor

Where the system allows it, notes open in Zotero's own rich-text note editor, so you get the same formatting, citations and annotation highlights as in Zotero. The editor appears in place:

- for a child note, click the note's row in the **Notes** section (the row shows the first line of the note, or "Untitled note") to open it below the row, and click the row again to close it. Hover the row for **Edit note** and **Move note to Trash**;
- for a standalone note, select it in the item list and it fills the item pane.

Notes save automatically a moment after you stop typing, and again when you switch to another note or item.

Links inside a note work as follows:

- web and email links open in your browser;
- a `zotero://` link to an item selects it in the library, and one to a PDF opens it;
- on a citation inside a note, **Show Item** selects the cited item and **Show on Page** opens its PDF at the cited page;
- on an annotation highlight, **Show on Page** opens the PDF at that annotation.

**Markdown fallback.** If the rich editor cannot be used (for example when the web view is not available, or the note editor files are missing), the app falls back to a simpler editor. It shows the note formatted, with an **Edit** / **Preview** toggle, and you write in Markdown (`# heading`, `**bold**`, `*italic*`, `- list`, `[text](url)`). It saves as you type and shows "Saving…" then "Saved". Notes that use formatting Markdown cannot hold (tables, images, citations, annotation highlights, superscripts) are edited there as raw HTML.

### Deleting notes

**Move note to Trash** sends the note to the Trash like any other item; restore it from the **Trash** view (see [Library basics](library.md#trash)).

## Web tabs: snapshots and EPUBs

PDFs open in the native [reader](reader.md). Web page snapshots and EPUB files open in a **web tab** instead. The button on the item header says **Open snapshot** or **Open EPUB** according to the attachment. A web tab is Zotero's own web reader running inside the app, so snapshots and EPUBs behave as they do in Zotero and share your library's annotations.

- A web tab is a normal tab beside the library; close it with `Ctrl+W`.
- Links in the document open in your browser. The popup on a citation can open the cited item in the library when it is already there.
- The web view is Microsoft Edge WebView2 on Windows (preinstalled on Windows 11) and the system's WKWebView on macOS, so there is nothing to install on either. On Linux it is WebKitGTK 6 with GTK 4 (Debian and Ubuntu package `libwebkitgtk-6.0-4`). Without them, snapshots and EPUBs open in the default app instead. Zinc runs on X11, or on XWayland under a Wayland desktop; setting `ZN_WAYLAND=1` keeps native Wayland but turns the web view off.
- The web view is created only when you open a web tab and released when the last web tab closes, because it uses noticeable memory while it exists.
- The web view floats over the tab area, so it is hidden while a menu, dialog or popover is open and while another tab is active.

If a web tab cannot be shown (web view missing, or the reader files unavailable), the tab says "Could not show … in the web view" with the reason, and an **Open in default app** button opens the file with whatever your system uses for it. When the web reader is not available at all, snapshots and EPUBs open in their default app straight away.

Snapshots come from the [browser connector](adding-items.md#the-browser-connector), which can store a snapshot of the page you save.

See also [Troubleshooting](troubleshooting.md) if the web view or note editor does not appear.
