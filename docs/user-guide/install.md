# Install

Zinc runs on Windows, Linux and macOS. Each release on the **Releases** page of the repository has one download per system:

| System | Download | Needs |
| --- | --- | --- |
| Windows 10 or 11, 64-bit | `Zinc-Setup-<version>.exe` | Nothing else. No administrator rights. |
| Linux, 64-bit (x86-64) | `Zinc-<version>-x86_64.AppImage` | A desktop on X11 or Wayland (through XWayland). For snapshots, EPUBs and the note editor: GTK 4 and WebKitGTK 6. |
| macOS 13 or later, Apple Silicon | `Zinc-<version>-arm64.dmg` | Nothing else. Intel Macs are not supported. |

Some parts are Windows only for now: the Word add-in, the Zinc browser connector's helper (which saves pages with the app closed), and the built-in sign-in window for Find Full Text. On Linux and macOS, use the official Zotero Connector while Zinc is open (see [Adding items](adding-items.md)).

## Windows

1. Download `Zinc-Setup-<version>.exe`. Version 0.1.2 and earlier are named `ZoteroNext-Setup-<version>.exe`.
2. Run it. If Windows shows **Windows protected your PC** (SmartScreen), click **More info**, then **Run anyway**. The installer is not code-signed yet, so Windows does not know the publisher.
3. Choose the components and tasks:
   - **Word add-in**: ticked by default. See [The Word add-in](word.md). Untick it if you do not use Word.
   - **Browser connector**: ticked by default. It saves pages from Chrome or Edge even when Zinc is closed. You load the extension yourself once; see [Adding items](adding-items.md).
   - A desktop shortcut (optional).
4. Finish. Start **Zinc** from the Start menu.

The program goes into `%LOCALAPPDATA%\Programs\Zinc`, with a Start-menu shortcut and an entry in **Apps & features** (under the current user). The installer never touches your library, your settings or your logs.

### Upgrading

Run a newer installer over the old one, or let the app update itself ([Updates](updates.md)). Files are replaced in place and your choice of components is remembered. If Zinc is running, the installer asks to close it. A silent install closes it for you and fails if the app does not close within 15 seconds. If Word is open, the installer leaves an installed add-in as it is.

### Silent install

For scripted installs:

```
Zinc-Setup-<version>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
```

Useful extras: `/COMPONENTS="app"`, `"app,word"` or `"app,word,connector"`, `/TASKS="desktopicon"`, `/DIR="<folder>"` and `/LOG="<file>"`. The full list is in `gpui-ui/installer/README.md`.

### Uninstall

Use **Apps & features**, or `unins000.exe /VERYSILENT /SUPPRESSMSGBOXES` from the install folder. The uninstaller removes the program files and its registry entries (and the Word add-in's registration). It then asks **Also remove settings and logs?** (the default is No). Answering yes removes `%APPDATA%\zotero-next-gpui` apart from any `*.sqlite` and `*.db` files, the web tabs' WebView2 profile, and the Word add-in's own data folders. A library is never removed.

## Linux

The AppImage is one file that runs without installing anything.

1. Download `Zinc-<version>-x86_64.AppImage`.
2. Make it executable: `chmod +x Zinc-<version>-x86_64.AppImage`, or tick **Allow executing file as program** in the file's properties.
3. Run it.

To add Zinc to the applications menu, use an AppImage manager such as Gear Lever or AppImageLauncher, or keep the file somewhere permanent and create a launcher for it.

Zinc runs on X11, and on Wayland desktops through XWayland, because it places the web view's window itself. Snapshots, EPUBs and the rich note editor need GTK 4 and WebKitGTK 6 (on Debian and Ubuntu, the package `libwebkitgtk-6.0-4`). Without them, those open in their default app instead; the library, the PDF reader and sync do not need them. Printing uses GTK's print dialog and CUPS.

Zinc updates itself ([Updates](updates.md)) if you can write to the folder that holds the AppImage. To update by hand, download the newer AppImage and replace the old file. To uninstall, delete the file. Settings and logs stay in `~/.config/zotero-next-gpui`, and a library you created stays where you put it (by default `~/.local/share/zotero-next/library.sqlite`).

## macOS

1. Download `Zinc-<version>-arm64.dmg` and open it.
2. Drag **Zinc** to **Applications**.
3. The app is not notarised by Apple yet. The first time, open the **Applications** folder, right-click **Zinc** and choose **Open**, then **Open** again. If macOS only offers **Move to Bin**, open **System Settings > Privacy & Security** and click **Open Anyway** next to the message about Zinc.

Zinc updates itself ([Updates](updates.md)) once it is in Applications or another folder you can write to. To update by hand, drag the newer Zinc over the old one. To uninstall, move Zinc to the Bin. Settings and logs stay in `~/Library/Application Support/zotero-next-gpui`, and a library you created stays where you put it (by default `~/Library/Application Support/zotero-next/library.sqlite`).

## The browser edition

Each release also has `Zinc-Web-<tag>.zip`: the same interface and core built for the browser, with GPUI, SQLite and PDFium compiled to WebAssembly and Zotero's layout analysis for the reader. It runs in a recent Chrome, Edge, Firefox or Safari on any system.

1. Download `Zinc-Web-<tag>.zip` (`ZoteroNext-Web-<tag>.zip` up to 0.1.2) from the **Releases** page and unzip it.
2. In the unzipped folder, start a static web server, for example `python3 -m http.server 8080`. Browsers only run WebAssembly and workers over `http://`, so opening `index.html` from disk does not work.
3. Open `http://localhost:8080`. Add `?open=demo` to open the demo article in the PDF reader, and `&view=reading` for its reading view.

For now the browser edition opens a demo library of well-known papers and keeps changes only until you close the tab. Web tabs, sync, importing files and anything else that needs your disk are in the desktop app only. The same build runs on the website's Demo page.

## Install with an AI agent

An agent with a shell, such as Claude Code, can do the install for you. Give it this page and ask it to follow this section. The **Download** page has a prompt to copy.

The steps below are written for the agent.

1. **Find the system.** Windows (x64), Linux (x86-64) or macOS (Apple Silicon). Any other system or CPU is not supported: tell the user and stop.
2. **Ask the user first.** On Windows, ask which parts they want: the app, the Word add-in and the browser connector (the default is all three). If they want the Word add-in, ask them to close Word. A silent install leaves the add-in as it is while Word is open.
3. **Download the release asset.** The repository is private, so use the GitHub CLI, signed in with an account that can read it. If `gh` is missing or not signed in, stop and ask the user to sign in (`gh auth login`). Never handle their password or token.

   ```sh
   # pattern: Windows "Zinc-Setup-*.exe", Linux "Zinc-*-x86_64.AppImage", macOS "Zinc-*-arm64.dmg"
   gh release download --repo ABorakati/zinc --pattern "<pattern>" --dir <temporary folder> --clobber
   ```

4. **Install it.**
   - **Windows** (PowerShell), with the parts the user chose:

     ```powershell
     $setup = Get-ChildItem <temporary folder> -Filter "Zinc-Setup-*.exe" | Select-Object -Last 1
     Start-Process $setup.FullName -Wait -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/COMPONENTS="app,word,connector"', '/LOG="<temporary folder>\install.log"'
     Test-Path "$env:LOCALAPPDATA\Programs\Zinc\zotero-next-gpui.exe"   # must be True; if not, report the end of install.log
     ```

     There is no administrator prompt, and a silent install shows no SmartScreen warning.
   - **Linux**: move the AppImage to a folder the user agrees to (for example `~/Applications`), then `chmod +x` it. Check that WebKitGTK 6 is installed (`ldconfig -p | grep libwebkitgtk-6.0`). If it is not, tell the user which package provides it on their distribution; do not install system packages without asking.
   - **macOS**: mount the image, copy the app, and unmount it:

     ```sh
     hdiutil attach -nobrowse -mountpoint /tmp/zinc-dmg <temporary folder>/Zinc-*-arm64.dmg
     ditto /tmp/zinc-dmg/Zinc.app /Applications/Zinc.app
     hdiutil detach /tmp/zinc-dmg
     ```

     Do not remove the quarantine flag or change Gatekeeper settings. Tell the user to open Zinc the first time with right-click > **Open**.
5. **Never touch security settings.** Do not change SmartScreen, Gatekeeper or any other security setting.
6. **Hand over to the user.** These steps need a person:
   - **Start Zinc** and choose a library (see [First run](first-run.md)). Importing from Zotero only reads the Zotero data folder. Do not copy, move or edit the Zotero data folder or a library file yourself.
   - **Windows, if they chose the browser connector: load the extension.** A browser does not let a program add an extension. Tell the user: open `edge://extensions` or `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `%LOCALAPPDATA%\Programs\Zinc\connector\extension`. The extension id must be `pakgagonakcalfbmckaolkpidcojacaf`.
   - **Linux and macOS: saving from the browser.** Suggest the official Zotero Connector from the browser's extension store. It saves into Zinc while Zinc is open.
7. **Connect the agent to the library (optional).** Ask the user first. When Zinc is running, its library MCP server answers on `http://127.0.0.1:23120/mcp` on every system. For Claude Code:

   ```sh
   claude mcp add --transport http zotero-next-http --scope user http://127.0.0.1:23120/mcp
   ```

   On Windows the Word add-in has its own MCP server, which needs a token from a file. Follow [MCP for AI agents](mcp.md) and never print the token.
8. **Clean up.** Delete the temporary folder (the download and the log) once the install has worked.

## Notes

- Windows: web tabs and the rich note editor use Microsoft Edge WebView2, preinstalled on Windows 11; see [Troubleshooting](troubleshooting.md) if they do not appear. The Word add-in is built for .NET Framework 4.8 and works with desktop Word.
- macOS: web tabs and the note editor use the system's WebKit; nothing to install.
