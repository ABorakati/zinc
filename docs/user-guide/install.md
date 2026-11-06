# Install

Zotero Next is a Windows program. It installs for the current user only and does not need administrator rights.

## Install it

1. Download `ZoteroNext-Setup-<version>.exe` from the **Releases** page of the repository.
2. Run it. If Windows shows **Windows protected your PC** (SmartScreen), click **More info**, then **Run anyway**. The installer is not code-signed yet, so Windows does not know the publisher.
3. Choose the components and tasks:
   - **Word add-in**: ticked by default. See [The Word add-in](word.md). Untick it if you do not use Word.
   - A desktop shortcut (optional).
4. Finish. Start **Zotero Next** from the Start menu.

The program goes into `%LOCALAPPDATA%\Programs\Zotero Next`, with a Start-menu shortcut and an entry in **Apps & features** (under the current user). The installer never touches your library, your settings or your logs.

## Upgrading

Run a newer installer over the old one, or let the app update itself ([Updates](updates.md)). Files are replaced in place and your choice of components is remembered. If Zotero Next is running, the installer asks to close it. A silent install closes it for you and fails if the app does not close within 15 seconds. If Word is open, the installer leaves an installed add-in as it is.

## Silent install

For scripted installs:

```
ZoteroNext-Setup-<version>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

Useful extras: `/COMPONENTS="app"` or `"app,word"`, `/TASKS="desktopicon"`, `/DIR="<folder>"` and `/LOG="<file>"`. The full list is in `gpui-ui/installer/README.md`.

## Uninstall

Use **Apps & features**, or `unins000.exe /VERYSILENT /SUPPRESSMSGBOXES` from the install folder. The uninstaller removes the program files and its registry entries (and the Word add-in's registration). It then asks **Also remove settings and logs?** (the default is No). Answering yes removes `%APPDATA%\zotero-next-gpui` apart from any `*.sqlite` and `*.db` files, the web tabs' WebView2 profile, and the Word add-in's own data folders. A library is never removed.

## Notes

- The app is built for 64-bit Windows. Web tabs and the rich note editor use WebView2; see [Troubleshooting](troubleshooting.md) if they do not appear.
- The Word add-in is built for .NET Framework 4.8 and works with desktop Word.
