# Troubleshooting and FAQ

First look at the [log](logs-and-reports.md). **Tools > Report a problem...** gathers the relevant part for you.

## The app will not open my library

- **"This library was opened by a newer version of zotero-next".** The library file was migrated by a newer build than the one you are running. Nothing was changed. Install the newer version ([Updates](updates.md)).
- **A migration failed.** The library file is unchanged (the migration runs in one transaction that is rolled back). The message names the backup `library.backup-v<from>-to-v<to>-<time>.sqlite` that was made next to the library first. See [Database and migrations](../developer-guide/database.md).
- **The first-run screen appears every time.** The saved library path points at a file that is not there, for example on an unplugged drive. The screen says so. Reconnect the drive, or open or import another library ([First run](first-run.md)).

## The browser connector says Zotero is not running

The app answers the Zotero connector on port 23119, but only while the real Zotero is not running, because Zotero holds that port itself. The app retries every 30 seconds. Quit Zotero. On Windows you can also use the native-messaging connector host, which does not need either program running ([Adding items](adding-items.md)).

The Better BibTeX endpoints are also served on 23119, so they have the same limit ([Better BibTeX](better-bibtex.md)).

## Port 23120 is busy

The core API normally uses 23120. If another copy of Zinc already holds it, the new process takes another free port.

## Web tabs or rich notes do not appear

They use the system web view and the note editor build. When the note editor is not available, notes fall back to a plainer Markdown editor ([Notes and web tabs](notes-and-web-tabs.md)).

- **Windows.** The web view is Microsoft Edge WebView2, preinstalled on Windows 11.
- **macOS.** It is the system's WKWebView. There is nothing to install.
- **Linux.** It needs GTK 4 and WebKitGTK 6 (Debian and Ubuntu package `libwebkitgtk-6.0-4`). Without them, snapshots and EPUBs open in the default app. `ZN_WAYLAND=1` keeps native Wayland but turns the web view off; leave it unset to run on X11 or XWayland.

## Find Full Text, or add from URL, finds nothing

Add from URL runs Zotero's translators and falls back to a plain webpage item when none matches. A translator is limited to 60 seconds and 25 HTTP requests ([translators](../developer-guide/translators.md)). Some publishers need your institution's sign-in for full text ([Find Full Text](find-full-text.md)).

## Windows says the publisher is unknown, or macOS will not open Zinc

The installers are not code-signed yet, so both systems warn you the first time.

- **Windows (SmartScreen).** Click **More info**, then **Run anyway**.
- **macOS.** Open the **Applications** folder, right-click **Zinc**, choose **Open**, then **Open** again. On macOS 15 and later, if there is no **Open** button, try to open Zinc once, then go to **System Settings > Privacy & Security** and click **Open Anyway**.
- **Linux.** There is no warning. If the AppImage will not start, run `chmod +x` on it, or allow it to run as a program in the file manager's properties.

## Word

The Word add-in and the Word MCP server are Windows only.

- **The sidebar does not appear.** Check that the **Word add-in** component was installed ([Install](install.md)) and see [The Word add-in](word.md).
- **Open in Zinc opens the PDF instead of selecting the item.** That is intended. Zinc opens the item's PDF, else its EPUB, else its web snapshot. Only an item with no file is selected in the **Library** tab ([The Word add-in](word.md#open-in-zinc)).
- **Open in Zinc takes a long time.** If Zinc is not running, the add-in starts it and waits up to about 40 seconds. Start Zinc first to avoid the wait.- **An agent gets 401 from the Word MCP.** It needs the bearer token from the add-in's token file, and requests from a browser (with an `Origin` header) are refused ([MCP](mcp.md)).

## Sync

- **Changes do not reach zotero.org.** Pushing is off until you turn on **Send changes to zotero.org**, and only one sync route runs at a time ([Sync](sync.md)).
- **Attachment files are missing after switching to zotero.org.** The default is not to sync files. Use the **Online-only files** check before you clear zotero.org storage.

## Updates are not offered

- **Version 0.1.10 or earlier.** These cannot update themselves. Install a newer release by hand ([Install](install.md)); from 0.1.11 on, Zinc updates itself.
- **A build run from source, or one without an update key,** never updates ([Updates](updates.md)).
- **"Could not install the update", or "has to be installed by hand".** On Linux the AppImage must be started from its own file, in a folder you can write to. On macOS Zinc must be in Applications (or another writable folder), not run from the disk image. Otherwise install the new release by hand ([Install](install.md)).
- **Nothing is offered.** Press **Check now** under **Settings > System > Updates**; it works even with **Check automatically** off. Leave **Update feed** empty unless you mean to use another one.

## FAQ

**Does it change my Zotero data?** Import only reads the Zotero data folder. Writing changes back into Zotero's database is a separate setting, **Write changes into Zotero** ([Sync](sync.md)).

**Where is my library?** In a single `.sqlite` file. **Settings > Files and folders > Library location** shows the path ([First run](first-run.md)).

**Is anything sent over the network without my asking?** Logs stay on your computer. The app contacts the update feed (the latest GitHub release) unless you turn off **Check automatically**, sync services only when you turn them on, and sites you add items from.

**Can I use it on macOS or Linux?** Yes. There is a Linux x64 AppImage and a macOS disk image for Apple Silicon (macOS 13 or later). See [Install](install.md). The Word add-in and the Zinc browser connector's helper are Windows only. Auto-update works on all three systems.

**Can I use it with the official Zotero Connector?** The app implements the connector protocol on port 23119, so the official connector can talk to it while Zotero is closed. On Windows the dedicated Zinc connector also works with neither program running ([Adding items](adding-items.md)).

**How do I report a bug?** [Logs and Report a problem](logs-and-reports.md).
