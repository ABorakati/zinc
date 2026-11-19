# Zinc for LibreOffice Writer

The Zinc sidebar (the same page as the Word add-in's, `word/sidebar`) docked in Writer's sidebar, with citations, a
bibliography and refresh in Zotero's document format. Design and status: [docs/design/libreoffice-sidebar.md](../docs/design/libreoffice-sidebar.md).

- `extension/`: the LibreOffice extension. `zinc.py` holds the UNO components (sidebar panel, Zinc menu commands);
  `pythonpath/zinc_lo/` holds the document code (`lodoc.py`), Zotero's storage format (`codes.py`) and the link to the pane
  (`pane.py`); `registry/` holds the sidebar deck, menu and toolbar.
- `pane/`: the pane process (Windows, .NET Framework 4.8). It shows the sidebar page in a WebView2 inside the panel and
  answers library and style requests with the Word add-in's code.
- `test/`: the headless-LibreOffice harness, the in-process benchmark, the hidden-desktop GUI check and the storage-format
  unit tests. The Bun tests that use them are `word/sidebar/test/libreoffice-*.test.ts`.

Build: `pwsh libreoffice/build.ps1` writes `libreoffice/dist/zinc-libreoffice.oxt`. Install it with Tools > Extensions in
LibreOffice 7.6 or later, or with `unopkg add`. Then open the Zinc deck from the sidebar's tab bar or the Zinc menu.
