# Install

Zinc is a Windows program. It installs for the current user only and does not need administrator rights.

## Install it

1. Download `Zinc-Setup-<version>.exe` from the **Releases** page of the repository. Version 0.1.2 and earlier are named `ZoteroNext-Setup-<version>.exe`.
2. Run it. If Windows shows **Windows protected your PC** (SmartScreen), click **More info**, then **Run anyway**. The installer is not code-signed yet, so Windows does not know the publisher.
3. Choose the components and tasks:
   - **Word add-in**: ticked by default. See [The Word add-in](word.md). Untick it if you do not use Word.
   - A desktop shortcut (optional).
4. Finish. Start **Zinc** from the Start menu.

The program goes into `%LOCALAPPDATA%\Programs\Zinc`, with a Start-menu shortcut and an entry in **Apps & features** (under the current user). The installer never touches your library, your settings or your logs.

## Upgrading

Run a newer installer over the old one, or let the app update itself ([Updates](updates.md)). Files are replaced in place and your choice of components is remembered. If Zinc is running, the installer asks to close it. A silent install closes it for you and fails if the app does not close within 15 seconds. If Word is open, the installer leaves an installed add-in as it is.

## Silent install

For scripted installs:

```
Zinc-Setup-<version>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

Useful extras: `/COMPONENTS="app"` or `"app,word"`, `/TASKS="desktopicon"`, `/DIR="<folder>"` and `/LOG="<file>"`. The full list is in `gpui-ui/installer/README.md`.

## Uninstall

Use **Apps & features**, or `unins000.exe /VERYSILENT /SUPPRESSMSGBOXES` from the install folder. The uninstaller removes the program files and its registry entries (and the Word add-in's registration). It then asks **Also remove settings and logs?** (the default is No). Answering yes removes `%APPDATA%\zotero-next-gpui` apart from any `*.sqlite` and `*.db` files, the web tabs' WebView2 profile, and the Word add-in's own data folders. A library is never removed.

## Linux and macOS: the browser edition

Each release also has `Zinc-Web-<tag>.zip`: the same interface and core built for the browser, with GPUI, SQLite and PDFium compiled to WebAssembly and Zotero's layout analysis for the reader. It runs in a recent Chrome, Edge, Firefox or Safari on Linux, macOS or Windows.

1. Download `Zinc-Web-<tag>.zip` (`ZoteroNext-Web-<tag>.zip` up to 0.1.2) from the **Releases** page and unzip it.
2. In the unzipped folder, start a static web server, for example `python3 -m http.server 8080`. Browsers only run WebAssembly and workers over `http://`, so opening `index.html` from disk does not work.
3. Open `http://localhost:8080`. Add `?open=demo` to open the demo article in the PDF reader, and `&view=reading` for its reading view.

For now the browser edition opens a demo library of well-known papers and keeps changes only until you close the tab. Web tabs, sync, importing files and anything else that needs your disk are in the Windows app only. The same build runs on the website's Demo page.

## Notes

- The app is built for 64-bit Windows. Web tabs and the rich note editor use WebView2; see [Troubleshooting](troubleshooting.md) if they do not appear.
- The Word add-in is built for .NET Framework 4.8 and works with desktop Word.
