# Changelog

All notable changes to Zinc are recorded in this file. Add an entry under [Unreleased] with your change; at a release, that section
becomes the new version's.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Zinc follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Versions 0.1.0 to 0.1.2 were released as Zotero Next. The entries for
0.1.0 to 0.2.5 are the GitHub release notes of those versions, without their install instructions.

## [Unreleased]

## [0.2.6] - 2026-11-21

Fixes the packaged plugin startup crash, Word citation search on older Windows SQLite builds, PDF reader page-jump crashes, and macOS/Linux system appearance tracking, and introduces an always-available application menubar (native `NSMenu` on macOS, compact top row on Windows and Linux).

### Changed

- **Application menubar:** the File / Edit / View / Go / Tools / Help menubar is now always available (not only when plugins are enabled) — rendered natively in the macOS system menu bar on macOS, and on its own compact top row above the tab strip on Windows and Linux.

### Fixed

- **"System" appearance follows macOS:** with Settings > Appearance on System, Zinc showed the dark theme on macOS whatever the system setting. It now follows the system's light or dark mode, and switches when you change it.
- **"System" appearance follows Linux:** with Settings > Appearance on System, Zinc showed the dark theme on Linux whatever the system setting. It now follows the light or dark style set in GNOME or KDE (read from the desktop portal), and switches when you change it.
- **Packaged app crashed on startup with plugins enabled:** enabling WASM plugins in Settings caused packaged builds on macOS and Windows to exit immediately with an `ENOENT` error scanning `/$bunfs/root/plugin-host/src/imports` (#2, #4). Plugin handlers are now bundled statically, packaged `zhw` signing/lookup is hardened, and plugin startup failures disable plugins cleanly instead of crashing the app.
- **Word citation search by author or title failed on older Windows SQLite builds:** on Windows builds where `winsqlite3.dll` lacks FTS5, searching by author or title in the Word add-in failed with `no such module: fts5` (#3). The add-in now detects missing FTS5 and falls back to a ranked search across titles, all authors (including co-authors), publication, abstract, DOI, and tags.
- **PDF reader crashed when jumping from bibliography to in-text citation:** rapid page jumps could upload a tile to an image element that had already unmounted (`Unknown element id`, #1). Image pixel uploads now guard against mount/unmount races cleanly.

## [0.2.5] - 2026-11-21

The attachment preview in the item pane now shows readable pages.

### Added

- **Attachment preview fits the pane's width:** the PDF preview at the top of the item pane's Attachments section shows pages as wide as the pane, instead of small thumbnails. In a wide pane (for example the item pane docked along the bottom of the window) a page is shown at up to 100% size, centred. The preview stays shorter than the pane, so you can still scroll past it. To go back to small thumbnails, turn off Settings > Reader > Fit attachment preview to width.

## [0.2.4] - 2026-11-19

Word no longer freezes on documents with certain tracked changes.

### Fixed

- **Word froze when inserting a citation:** in some documents with Track Changes, Word's list of tracked changes repeats endlessly (for example, tracked language changes in the bibliography). The refresh after inserting a citation read that list and never finished, so Word stopped responding. The same happened when inserting or editing the bibliography, editing or deleting a citation, changing the citation style, or clicking Refresh. Zinc now reads only as many tracked changes as Word reports, skips any it cannot return, and stops after a few seconds per citation.

Close Word before you install, so the add-in can be replaced.

What's new in 0.2.3: [installing plugins from Settings and single-file plugins](https://github.com/ABorakati/zinc/releases/tag/v0.2.3).

## [0.2.3] - 2026-11-19

Install plugins from Settings, and plugins as a single .wasm file.

### Added

- **Install plugins from Settings:** Settings > Plugins > **Install a plugin** > **Install from file...** installs or updates a plugin. Before any of its code runs you see what it asks for, grouped by risk, with the plugin's reason for each permission. High-risk permissions start unticked, and anything you untick is refused. Plugins must be turned on first (Enable plugins, then restart Zinc).
- **Manage installed plugins:** each plugin in Settings > Plugins has a switch to turn it off and on, a **Remove** button (it asks first, then deletes the plugin with its settings and data; your library is not touched), and **Review permissions...** when an update asks for more.
- **Single-file plugins:** a plugin can now be one `.wasm` file with its manifest and strings inside, as well as a `.zplugin`. Both install the same way and run the same code.
- **Docs:** new user-guide pages for [Layouts](https://aborakati.github.io/zinc/user-guide/layouts/) and [Plugins](https://aborakati.github.io/zinc/user-guide/plugins/), and the agent skills for plugin authors (`zinc-plugin-create`, `zinc-plugin-port`) as downloads on the [website](https://aborakati.github.io/zinc/developer-guide/wasm-plugins/agent-skills/). The skills now cover tools for AI agents (MCP) and can scaffold one.

Plugins are still experimental and off by default.

## [0.2.2] - 2026-11-19

Switches and checkboxes work again.

### Fixed

- **Switches and checkboxes ignored clicks:** clicking a switch (for example Settings > Plugins > Enable plugins, or Settings > System > Check automatically) or a checkbox did nothing. They now turn on and off with the mouse. Turning plugins on still takes effect the next time Zinc starts.
- **Import from PubMed (.nbib) files:** an empty author line no longer adds an author with an empty last name.

## [0.2.1] - 2026-11-19

Clearer dragging when you customize the layout.

### Fixed

- **Dragging panes in Edit layout:** the grip at the left of each pane's header is now a proper handle that drags the pane (in 0.2.0 it was a small icon that did nothing; only the header text could be dragged). Headers are a little taller in edit mode, and show a grab cursor.
- **You can see that a drag has started:** the grip, tab or section title you press is highlighted at once; while you drag, the pane you are moving fades, every place it can go is outlined, and the place under the pointer says what will happen ("Place below My Library", "Stack with Item details as a tab", "Return to the item pane").

## [0.2.0] - 2026-11-19

Arrange the library the way you like, a much faster Word add-in, and a first look at plugins.

### Added

- **Customizable layout:** choose how the library is arranged in Settings > Appearance > Layout: **Standard** (sidebar, item list and item details side by side), **Stacked** (item details below the list, for narrow or portrait screens) or **Triage** (a wide list with Tags and Collections beside it).
- **Edit layout:** Settings > Appearance > Layout > Customize… (or Tools > Edit layout) shows a header on every pane. Drag a pane by its header to put it beside, above or below another pane, or onto another pane to stack the two as tabs. Use its ⋯ menu to move, stack or hide it, and Undo from the notice if you change your mind. Press Done or Escape to finish; Reset layout returns to your chosen default. Outside edit mode the window looks as before.
- **Item pane sections as panes:** drag a section's title (Details, Abstract, Notes, Files, Collections, Tags, Related) out of the item pane to give it a pane of its own, for example Tags beside the list while you sort. It follows the selected item. Drag it back, or use Settings > Appearance > Sidebars > Return to item pane.
- **Keyboard:** F6 and Shift+F6 move between panes; the dividers between panes can be focused with Tab and moved with the arrow keys (Shift for bigger steps).
- **Plugins (preview, off by default):** Zinc can run plugins compiled to WebAssembly in a sandbox, with item pane sections, side panels, tabs, menu entries and toolbar buttons. Turn them on in Settings > Plugins > Enable plugins (experimental); it takes effect the next time Zinc starts. The developer guide explains how to write one.

### Fixed

- **Word add-in no longer slows Word down:** clicking a citation could hang Word for a long time on large documents or documents under review (Track Changes). The add-in now reads only what it needs, refreshes all citations in one pass, and reads tracked changes per citation instead of for the whole document. In a test document with about 1,000 citations, clicking a citation went from about 20 seconds to a tenth of a second, and reading all citations from 17-40 seconds to 6-9.
- **Citations refresh cleanly with Track Changes on:** refreshing no longer leaves tracked deletions inside citation fields, which could make Word show a field's code after accepting changes.

## [0.1.18] - 2026-11-17

Scrollbars you can really drag, a page preview of the selected PDF, and a faster macOS build.

### Added

- **PDF page preview in the item pane:** the selected item's PDF pages appear as thumbnails in a strip above its attachments. Scroll through them; double-click a page to open the PDF in the reader at that page. It shows without starting the full reader, and moving quickly through the list with the arrow keys only loads the item you stop on. Very large PDFs (over about 30 MB) show a "Show preview" button instead.
- **Verifiable downloads:** the files built on GitHub (Linux AppImage, macOS disk image and app zip, Zinc Connector zips, browser edition zip) now come with GitHub build attestations: `gh attestation verify <file> -R ABorakati/zinc` shows the workflow and commit that built it. The Windows installer is built outside GitHub and has none; its SHA-256 is in the `.json` beside it.
- **macOS:** the app is now the ahead-of-time compiled build, as on Windows, which starts faster. (Linux keeps the current build for now: the faster one does not run on machines without a graphics driver.)

### Fixed

- **Scrollbars can be dragged:** in the item list (List and Classic views), in the PDF reader and in the new page preview. Press the scrollbar thumb and drag, or press elsewhere on the scrollbar to jump there. (0.1.17's fix did not reach the real cause: the scrollbar drawn by the app's graphics layer never took the mouse.)

## [0.1.17] - 2026-11-17

Scrollbars you can drag: the item list's again, and the PDF reader now has one.

### Fixed

- **Item list scrollbar:** pressing the scrollbar thumb could go to the item row underneath it instead, so the scrollbar would not drag (a long drag could start dragging the item instead). The rows now stop just short of the scrollbar, in both the List and the Classic view.
- **PDF reader scrollbar:** the page area had no scrollbar. It now has one you can drag, and one for scrolling sideways when you zoom in.

Also in this release, if you are coming from 0.1.15: everything in 0.1.16 (Zotero's keyboard shortcuts, changing any shortcut in Settings > Shortcuts, arrow keys in the sidebar and after clicking an item, Zotero's reader keys).

## [0.1.16] - 2026-11-17

Zotero's keyboard shortcuts, and you can change any of them.

### Added

- **Zotero's shortcuts in the library:** `Ctrl+Shift+O` new note, `Ctrl+Shift+I` Import, `Ctrl+Shift+Alt+I` Import from Clipboard, `Ctrl+Shift+K` or `Ctrl+F` quick search, `Ctrl+Shift+T` show or hide the tag selector, `Ctrl+Shift+L` focus the sidebar. Tabs: `Ctrl+Tab` / `Ctrl+Shift+Tab`, `Ctrl+PageDown` / `Ctrl+PageUp`, `Ctrl+1` to `Ctrl+9`.
- **Coloured tags from the keyboard:** in the item list, `1` to `9` add the tag coloured at that position to the selected items, or remove it when they all have it.
- **Arrow keys in the sidebar:** Up / Down move through My Library, the views, saved searches and collections; Left / Right collapse and expand collections; Home / End; `F2` renames a collection or saved search, `Delete` deletes it.
- **Change any shortcut** in Settings > Shortcuts: Change, then press the new keys. Remove and Reset undo it. If the keys belong to another command, they move over and you are told which. The menus and the Keyboard Shortcuts list (`Ctrl+/`) show your keys.
- **Reader:** Zotero's annotation keys (`Alt+1`/`2`/`3` highlight, underline, note; `Alt+6`/`7` draw, eraser; `Alt+8` next colour; `1`–`8` pick a colour; `Ctrl+Alt+1`/`2` highlight or underline the selected text; `Delete` removes the selected annotation), `Ctrl+Alt+G` page box, `Alt+Up` / `Alt+Down` previous / next page, and `Alt+Right` forward, with a new Forward button.

### Changed

To match Zotero:

- **`Ctrl+Shift+I` is now Import.** Add Item by Identifier has no shortcut by default; give it one in Settings > Shortcuts.
- **`Delete` in a collection** removes the items from that collection; they stay in your library. **`Shift+Delete`** moves items to the Trash without asking (it used to delete them permanently; that is still `Delete` in the Trash).

### Fixed

- **Arrow keys after clicking an item:** clicking an item did not give the item list the keyboard, so Up / Down did nothing until you pressed Tab.

## [0.1.15] - 2026-11-17

"Open in Zinc" from Word opens the item's PDF or snapshot, or shows the item in your library.

### Fixed

- **Open in Zinc in the Word sidebar** now opens the cited item's PDF in Zinc's reader (else its EPUB, else its web snapshot). An item with no file is shown in the library instead: selected and scrolled into view. When it is not in the collection or search you are looking at, Zinc switches to My Library and clears the search first. Before, Zinc only came to the front.

## [0.1.14] - 2026-11-17

"Open in Zinc" from Word brings Zinc to the front again.

### Changed

- **Download page:** how to get past the unsigned-app warnings on Windows (SmartScreen: More info, then Run anyway) and macOS (right-click, Open; on macOS 15 and later, System Settings > Privacy & Security > Open Anyway).

### Fixed

- **Open in Zinc in the Word sidebar** seemed to do nothing. Zinc did select the item, but its window stayed behind Word: the add-in looked for the window of the older app. It now finds the current one and brings it forward.

## [0.1.13] - 2026-11-16

Choose what the sidebars show, and in which order.

### Added

- **Settings > Appearance > Sidebars.** Show, hide and reorder the left sidebar's groups (Library, Saved Searches, Collections, Group Libraries, Tags) and the item pane's sections (Details, Abstract, Notes, Files, Collections, Tags, Related). The item pane's tabs follow the same order. Tags stays at the bottom of the left sidebar, and at least one part stays shown on each side. **Reset** restores the default.

### Changed

- **Saved Searches** is a group of its own in the left sidebar. It used to show only while Library was open.

### Fixed

- **Double-clicking an attachment under an opened item** sometimes did nothing: a refresh of the list turned the attachment rows into placeholders for a moment. They now stay put, and two quick clicks on the same row always open it.
- **After a self-update** the new version could keep using the previous version's PDF library, translators and reader pages until it was restarted (it inherited their paths from the old process). It now uses its own.

## [0.1.12] - 2026-11-16

Attachments and notes open under their item, as in Zotero, and the item list's toolbars fit narrow windows.

### Added

- **Attachments under each item.** Items with attachments or notes have a twisty in both the List and the Classic view. Open it to see every attachment and note as an indented row. Double-click a row (or press Enter) to open it; click it to show it in the item pane. Right opens an item and Left closes it; + opens every item on screen and - closes them all.

### Changed

- **Sidebar.** The selected row's outline is the same thickness all round (it was thicker at the rounded corners), and the section headers show their grey band only when you point at them.
- **Narrow windows.** The search box keeps its room: the List/Classic switch, then Add, show icons only when the list is narrow. The Group/Sort bar drops its labels to icons and shortens long sort names instead of running past the edge. The item pane's buttons keep a gap between wrapped rows.

## [0.1.11] - 2026-11-16

Zinc now updates itself, on Windows, Linux and macOS, and the browser connector tells you when a new version is out.

### Added

- **Automatic updates.** From this version on, Zinc checks this repository for a newer release, verifies its signature and offers to install it (Settings > System > Updates). Versions before 0.1.11 cannot do this, so install this one by hand once.
- **Connector update notice.** An unpacked install of the Zinc Connector checks once a day and tells you when a newer version is released.

Everything else is as in 0.1.10: the Linux AppImage and macOS app, your library in a browser tab with editing, and the fixes listed there.

## [0.1.10] - 2026-11-16

Zinc for Linux and macOS, and your library in a browser tab through the Zinc Connector.

### Added

- **Linux and macOS.** `Zinc-0.1.10-x86_64.AppImage` for Linux (x64) and `Zinc-0.1.10-arm64.dmg` for macOS (Apple Silicon) are attached to this release. Snapshots, EPUBs, the note editor and printing work on both. On Linux they need GTK 4 and WebKitGTK 6. The Word add-in, the browser connector and institution sign-in for Find Full Text are Windows only for now.
- **Your library in the browser.** In the Zinc Connector, **Open Zinc library** (toolbar menu or right-click) opens the full app in a browser tab. You can read PDFs, EPUBs and snapshots there, and edit items, collections, tags and notes. The changes go straight into the library Zinc uses on this computer.
- **Save popup.** It shows what is being saved, under the toolbar button, with Remove, Cancel and Open item.
- **Reading view.** The **Aa** panel previews fonts and themes, with Literata, the system font, or your own fonts.

### Fixed

- **Open Zinc library** in the connector's right-click menu did nothing. It works now, also after the browser has put the extension to sleep.
- The save popup no longer spins for about 6 seconds on pages where there is nothing to save.
- Zinc no longer starts the institution sign-in browser at launch. That saves about 400 MB of memory until you use Find Full Text.
- **Report a problem**: the GitHub issue link is a real link, and **File an issue** copies the report and opens a new issue.

## [0.1.9] - 2026-11-10

Calmer sidebar headers: the section bands from 0.1.8 are now a faded grey, and they line up with the selected row.

### Changed

- **Sidebar section headers are grey, not blue.** Library, Saved Searches, Collections, Group Libraries and Tags each sit on a faded grey band with grey labels, in light and dark mode.
- **The bands line up with the selected row.** A band now has the same left and right edges and the same rounded corners as the highlighted row under it. In the Tags pane, the header and the filter box line up the same way.

## [0.1.8] - 2026-11-10

Easier-to-scan sidebar: each section now has its own coloured header.

### Changed

- **Sidebar section headers stand out.** Library, Saved Searches, Collections, Group Libraries and Tags each sit on a band in a light tint of your accent colour, so the sections no longer blend into their rows. The band follows the accent scheme you choose in Settings, in light and dark mode.
- **The tag filter looks like a text field.** It is now a white (dark grey in dark mode) box with a border and a search icon, instead of a beige box that matched the sidebar.

## [0.1.7] - 2026-11-09

Fixes web snapshots disappearing after minimising, restoring or resizing the window.

### Fixed

- **A web snapshot stayed hidden behind the window after minimise/restore or a resize**, leaving the tab showing "Opening…". Since 0.1.6 the snapshot's web view is no longer owned by the app window (which fixed the freezes), so Zinc raises it over the window itself; Windows refused the plain request to raise it, and now Zinc uses one that Windows allows.

## [0.1.6] - 2026-11-09

Fixes a freeze when opening web snapshots or closing the app, and makes long menus easier to use.

### Changed

- **Long menus are compact and scroll.** Add to collection and other long lists use smaller rows and are capped in height (submenus 420 px, long lists 520 px), every level scrolls including submenus, and very long names end in an ellipsis instead of widening the menu.

### Fixed

- **Opening a web snapshot, or closing the app with one open, could freeze Zinc for several seconds** (Windows showed "Not responding"). The snapshot's web view window was owned by the app window across two threads, and the two could wait on each other. The web view is no longer owned by the app window; Zinc keeps it above the app window and hides it while the app is minimised itself.

## [0.1.5] - 2026-11-09

Better collection menus and more ways to group the item list.

### Changed

- **Add to collection** shows your collections as a tree, like the sidebar: a collection with subcollections opens a submenu that starts with the collection itself, pinned collections come first, and each collection has its sidebar icon and colour. For a single item, the collections it is already in are ticked. No more long "A / B / C" paths.
- **Show in collection…** lists collection names, with the parent path only when two share a name.
- **Group by** has six more options: First author, Date added and Date modified (by month, newest first), Has PDF, Language and Publisher. First author and Has PDF are also new sort options.

## [0.1.4] - 2026-11-09

Safety and security fixes from two independent code reviews, faster Word refreshes, and a faster browser connector.

### Changed

- **Word refreshes.** In author-date styles such as APA, a refresh after an edit now takes tens to a few hundred milliseconds instead of 0.6–3.4 s. The citation engine is kept per document and only the changed citations are reformatted.
- **Browser connector.** A large PDF no longer holds up other saves: a second save during a 20 MB upload answers in 16–32 ms (was 200–400 ms), and the PDF itself saves 2–4× faster. An item's attachments upload side by side. Translators come from your local copy instead of zotero.org, and the connection check no longer writes to disk on every page load.
- Retry when part of a list fails to load; keyboard-usable controls with a focus ring; clearer item-pane labels; read-only group libraries are locked throughout, including the PDF reader; "Add note from annotations" works on the first PDF; search and suggestions follow the selected library.
- Tag selection is now one tag at a time (selecting several only ever filtered by the first).

### Fixed

- Local Zotero sync never sends changes after a failed fetch and does not overwrite items Zotero changed in the meantime. A deletion from another device keeps child notes you have not synced yet. Items that fail to apply are retried.
- zotero.org sync stays linked to one account; switching accounts is an explicit step in Settings. Changed attachment files sync, with a conflict copy when both sides changed.
- Importing from Zotero builds the new library first and only then replaces the old one, and the search index is rebuilt.
- Tags, related items, PDF edits, file moves and duplicate merges respect group libraries and their permissions. Deleting PDF pages and moving their annotations is one operation that can be undone if it fails.
- Word: merging adjacent citations keeps page numbers; split and convert undo themselves on failure; editing a hand-edited citation asks first; group-library citations keep their links.

### Security

- Web pages can no longer call the connector, Word integration or Better BibTeX endpoints on port 23119. Better BibTeX actions that change things need a POST request, and auto-export can only write bibliography files.
- Files saved from the web never keep a program extension, and Zinc asks before opening a program file.
- Imports only copy files from the import's own folder.
- The Word add-in's sidebar can only show its own pages and cannot change the launcher; Word integration sessions time out.

## [0.1.3] - 2026-11-09

Zotero Next is now **Zinc**.

**Upgrading from 0.1.x:**

Run `Zinc-Setup-*.exe`. It upgrades Zotero Next in place: your library, settings, data folders, Word add-in and connector stay where they are, and the old "Zotero Next" shortcuts are replaced by "Zinc" ones. There is no library migration in this release. Close Word first so the add-in can be replaced. The installer is not code-signed, so Windows SmartScreen may ask you to confirm.

The MCP server keeps its id `zotero-next`, so existing MCP client configurations keep working.

### Changed

- **New name.** Zotero is a trademark of the Corporation for Digital Scholarship, so the app has a name of its own. Zn is zinc's chemical symbol, and ZN was already the project's short name. The window titles, Word ribbon and sidebar, browser connector ("Save to Zinc"), installer and messages all say Zinc.
- **New icon.** The red tile now reads Zn.
- **Licence.** Zinc is licensed under the GNU AGPL-3.0 or later, the same licence as Zotero.
- **Side project, no warranty.** Zinc is a personal side project with no warranty and no promise of maintenance. Keep backups of your library. See CONTRIBUTING.md.

Installers and browser zips from this release on are named `Zinc-Setup-*` and `Zinc-Web-*`.

## [0.1.2] - 2026-11-09

Group libraries, and a browser edition of the app.

**Upgrade note:**

The first start migrates your library to the new format (migration 4). The migration only adds data: it adds a `libraries` table and a library column, and your existing items stay in My Library. The app backs up the library first, as before. Earlier versions cannot open the library after this.

If you use the MCP server, restart it after upgrading so it runs the new code.

### Added

- **Group libraries.** Your zotero.org groups appear under My Library in the sidebar, each with its own collections. Items, tags, search, the item pane and the add actions work in the selected group. Groups where you can only read are locked for editing.
- **Group sync through zotero.org.** Each group is pulled and pushed separately, with the group's own permissions and file settings. Read-only groups are never pushed. Settings shows a sync status row for each group. A group you leave is hidden, and its data is kept.
- **Browser edition.** `ZoteroNext-Web-v0.1.2.zip` runs the app in a browser on Linux, macOS or Windows, with the PDF reader, layout analysis and the reading view. It installs as an app (PWA) and works offline. See `README.txt` in the zip.

## [0.1.1] - 2026-11-07

Word add-in fixes on top of 0.1.0. The app itself is unchanged.

### Changed

- **The sidebar and the citation popup follow Word's Office theme** (Colorful/White, Dark Gray, Black, or "Use system setting") instead of the Windows app mode, with Office's own neutral greys. Switching the theme in Word updates them within 2 seconds.

### Fixed

- **Word sidebar and agent server start again.** In 0.1.0 the sidebar stayed blank and the add-in's MCP tools failed with `0x8007139F`, because the citation popup's WebView2 used a different DPI mode from the sidebar and the agent page. Each DPI mode now gets its own WebView2 environment.

## [0.1.0] - 2026-11-07

First release of Zotero Next: a native Windows reference manager that reads and writes your Zotero library.

**Upgrading the library:**

The first start upgrades the library database to schema v3 (it adds the search index). A backup named `library.backup-v2-to-v3-<time>.sqlite` is written next to the library first. Older builds of Zotero Next refuse a v3 library, so update every copy of the app.

**Known limits:**

- Windows 10/11 x64 only.
- No group libraries, no Zotero plugins, no LibreOffice or Google Docs integration.
- Real-world institution sign-in flows are new: report any that fail with the app's **Report a problem** command.

### Added

- Native interface (GPUI), compiled ahead of time with Bun: the window is on screen in about 0.5 s and the library is ready in about 0.7 s, against 1.8 s and 16 s for Zotero 10 on the same library (see the README benchmarks).
- Fast search: toolbar search uses a trigram index (library schema v3), so most searches take a few milliseconds.
- Native PDF reader with annotations, a reflowed reading view with figure, table and reference cards.
- Sync with a local Zotero, or with zotero.org (optionally without attachments).
- Better BibTeX, ZotMoov-style file handling, Zotero's own translators and lookup engines, built in.
- Word add-in with a sidebar and an MCP server for agents; MCP server for the library.
- Drag items out of the window into Word, a browser or an email to drop a formatted reference (Shift for an in-text citation).
- Institution sign-in window (OpenAthens, Shibboleth, library proxy) for Find Full Text; a sign-in from the earlier Electrobun build is carried over.
- Browser connector (native messaging) included in the installer.

[unreleased]: https://github.com/ABorakati/zinc/compare/v0.2.6...HEAD
[0.2.6]: https://github.com/ABorakati/zinc/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/ABorakati/zinc/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/ABorakati/zinc/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/ABorakati/zinc/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/ABorakati/zinc/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/ABorakati/zinc/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ABorakati/zinc/compare/v0.1.18...v0.2.0
[0.1.18]: https://github.com/ABorakati/zinc/compare/v0.1.17...v0.1.18
[0.1.17]: https://github.com/ABorakati/zinc/compare/v0.1.16...v0.1.17
[0.1.16]: https://github.com/ABorakati/zinc/compare/v0.1.15...v0.1.16
[0.1.15]: https://github.com/ABorakati/zinc/compare/v0.1.14...v0.1.15
[0.1.14]: https://github.com/ABorakati/zinc/compare/v0.1.13...v0.1.14
[0.1.13]: https://github.com/ABorakati/zinc/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/ABorakati/zinc/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/ABorakati/zinc/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/ABorakati/zinc/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/ABorakati/zinc/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/ABorakati/zinc/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/ABorakati/zinc/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/ABorakati/zinc/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/ABorakati/zinc/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/ABorakati/zinc/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/ABorakati/zinc/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/ABorakati/zinc/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ABorakati/zinc/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ABorakati/zinc/releases/tag/v0.1.0
