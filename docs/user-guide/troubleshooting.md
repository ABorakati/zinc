# Troubleshooting and FAQ

First look at the [log](logs-and-reports.md). **Tools > Report a problem...** gathers the relevant part for you.

## The app will not open my library

- **"This library was opened by a newer version of zotero-next".** The library file was migrated by a newer build than the one you are running. Nothing was changed. Install the newer version ([Updates](updates.md)).
- **A migration failed.** The library file is unchanged (the migration runs in one transaction that is rolled back). The message names the backup `library.backup-v<from>-to-v<to>-<time>.sqlite` that was made next to the library first. See [Database and migrations](../developer-guide/database.md).
- **The first-run screen appears every time.** The saved library path points at a file that is not there, for example on an unplugged drive. The screen says so. Reconnect the drive, or open or import another library ([First run](first-run.md)).

## The browser connector says Zotero is not running

The app answers the Zotero connector on port 23119, but only while the real Zotero is not running, because Zotero holds that port itself. The app retries every 30 seconds. Quit Zotero, or use the native-messaging connector host, which does not need either program running ([Adding items](adding-items.md)).

The Better BibTeX endpoints are also served on 23119, so they have the same limit ([Better BibTeX](better-bibtex.md)).

## Port 23120 is busy

The core API normally uses 23120. If another copy of Zotero Next already holds it, the new process takes another free port.

## Web tabs or rich notes do not appear

They use WebView2 and the note editor build. When the note editor is not available, notes fall back to a plainer Markdown editor ([Notes and web tabs](notes-and-web-tabs.md)).

## Find Full Text, or add from URL, finds nothing

Add from URL runs Zotero's translators and falls back to a plain webpage item when none matches. A translator is limited to 60 seconds and 25 HTTP requests ([translators](../developer-guide/translators.md)). Some publishers need your institution's sign-in for full text ([Find Full Text](find-full-text.md)).

## Word

- **The sidebar does not appear.** Check that the **Word add-in** component was installed ([Install](install.md)) and see [The Word add-in](word.md).
- **An agent gets 401 from the Word MCP.** It needs the bearer token from the add-in's token file, and requests from a browser (with an `Origin` header) are refused ([MCP](mcp.md)).

## Sync

- **Changes do not reach zotero.org.** Pushing is off until you turn on **Send changes to zotero.org**, and only one sync route runs at a time ([Sync](sync.md)).
- **Attachment files are missing after switching to zotero.org.** The default is not to sync files. Use the **Online-only files** check before you clear zotero.org storage.

## Updates are not offered

A build run from source, a build without an update key, or one with no feed address never updates ([Updates](updates.md)).

## FAQ

**Does it change my Zotero data?** Import only reads the Zotero data folder. Writing changes back into Zotero's database is a separate setting, **Write changes into Zotero** ([Sync](sync.md)).

**Where is my library?** In a single `.sqlite` file. **Settings > Files and folders > Library location** shows the path ([First run](first-run.md)).

**Is anything sent over the network without my asking?** Logs stay on your computer. The app contacts the update feed only if one is configured, sync services only when you turn them on, and sites you add items from.

**Can I use it on macOS or Linux?** No. It is built for Windows.

**Can I use it with the official Zotero Connector?** The app implements the connector protocol on port 23119, so the official connector can talk to it while Zotero is closed. The dedicated Zotero Next connector also works with neither program running ([Adding items](adding-items.md)).

**How do I report a bug?** [Logs and Report a problem](logs-and-reports.md).
