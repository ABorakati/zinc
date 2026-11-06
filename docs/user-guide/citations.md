# Citations and bibliographies

Zotero Next formats citations and bibliographies with the CSL engine (citeproc-js). You can copy a formatted citation straight from the library (Quick Copy), build a bibliography from selected items or a whole collection, or insert live citations into a Word document with the [Word add-in](word.md).

## Citation styles

Styles are Citation Style Language (`.csl`) files. A handful are built in; the rest come from the Zotero Style Repository (around 10,000 styles) and are downloaded the first time you use them.

Built-in styles: Vancouver, APA 7th edition, Nature, The Lancet, BMJ, American Medical Association 11th edition, Cite Them Right 12th edition (Harvard) and Chicago 18th edition (author-date). The default is Vancouver.

The style picker (opened from **Browse all styles...** in [Settings > Cite](settings.md#cite), or **Choose style...** in the Create Bibliography dialog) lets you:

- search by title, short title or style id;
- filter by format (Any format, Author-date, Numeric, Note, Label, Author) and by field (Medicine, Biology, Psychology, Law and so on);
- tick an option to list installed styles only;
- see a live preview, using your selected items (up to three) or a few items from the library, before you commit to a style.

Choosing a style that is not installed downloads it. Installed styles are kept in a `styles` folder next to your library database. Offline, the picker uses the last cached index of the repository, which is refreshed at most daily. The built-in styles, the current Quick Copy style, and a parent style that other installed styles depend on cannot be removed.

## Quick Copy

Quick Copy puts a formatted reference on the clipboard in one step. Select one or more items in the library, then:

| Action | Shortcut | Result |
| --- | --- | --- |
| Copy Citation | Ctrl+Shift+A | In-text citation(s) for the selection |
| Copy Bibliography | Ctrl+Shift+C | Full bibliography entries for the selection |

Both actions are also in the item right-click menu. The clipboard receives rich text (HTML) and plain text together, so pasting into Word keeps italics and other formatting, while pasting into a plain-text editor gives clean text. A toast confirms what was copied, how many items, and which style was used.

If you select a child note or attachment, it resolves to its parent item. Duplicate items are dropped and the order you selected is kept.

### Quick Copy settings

Open **Settings > Cite**, or use **Citation Style Settings...** in the Tools menu (the wrench button in the toolbar). Changes in Settings > Cite are saved as soon as you make them.

| Setting | What it does |
| --- | --- |
| Quick Copy style | The citation style used by Copy Citation and Copy Bibliography. **Browse all styles...** opens the full picker. |
| Language | The locale used for citations, for example English (UK). "Style default" uses the style's own locale. |
| Quick Copy output | Whether the Create Bibliography dialog starts on Bibliography or Citations. |
| Quick Copy format | Whether the Create Bibliography dialog starts on HTML, Plain text or Rich Text (RTF). |

The shortcuts and the right-click commands always use the Quick Copy style and language. "Quick Copy output" and "Quick Copy format" only set the starting point of Create Bibliography. These values are stored in `cite-settings.json` next to the library database. See the [settings reference](settings.md#cite) for the full list.

## Create a bibliography

You can build a bibliography from items or from a whole collection:

- Select items, right-click and choose **Create Bibliography from Items...**.
- Right-click a collection in the sidebar and choose **Create Bibliography from Collection...**.

The dialog shows a live preview and has these controls:

- **Choose style...** switches style for this bibliography only (it does not change your Quick Copy style).
- **Output mode**: Bibliography (full entries) or Citations (in-text citations).
- **Output format**: HTML, Plain text or Rich Text (RTF).
- **Language**: the locale, or Style default.
- **Save as .html / .txt / .rtf...** writes the result to a folder you pick (the file is named `bibliography.<ext>`, or `citations.<ext>` in Citations mode).
- **Copy to Clipboard** copies the HTML and plain-text versions.

## Citing in Word

For live citations that you can edit and refresh, use the Word add-in rather than copy and paste. It inserts citations as fields, keeps a bibliography up to date, and has its own style picker. See [Word add-in](word.md).

## Dragging items out of the app

You can drag items (one or several) from the item list, in both the card view and the table view: hold the left mouse button and move the pointer a few pixels.

- **Onto a collection** in the sidebar: the items are added to that collection.
- **Out of the window**, into Word, a browser text box, an email or any app that accepts dropped text: the drop inserts a formatted reference, as in Zotero. The text comes from Quick Copy (its style or export format, language, and HTML or plain text). By default the drop is a bibliography entry; hold **Shift** as the pointer leaves the window to drop an in-text citation instead. Hold **Alt** when you start the drag to go straight to the outside drag.
- The text is prepared while you drag. For a very large selection it may not be ready in time; if you release the button first, or the system drag cannot start, the text is put on the clipboard instead and a message says so. Paste it with Ctrl+V.

Drag-out is Windows only. To see why a drag fell back to the clipboard, start the app with `ZN_DRAG_DEBUG=1` and look in the [log](logs-and-reports.md).

For live, editable citations, use the [Word add-in](word.md) instead of dropped text.

## Citation keys and LaTeX

If you write in LaTeX or Markdown, Better BibTeX gives each item a stable citation key and can copy `\cite{...}` commands. See [Better BibTeX](better-bibtex.md). To get references into other tools as files, see [Import and export](import-export.md).

## For developers

The same formatting is available over the local HTTP API (`/api/cite/...`) and through the [MCP server](mcp.md). The routes are documented at the top of `core/src/cite/types.ts`.
