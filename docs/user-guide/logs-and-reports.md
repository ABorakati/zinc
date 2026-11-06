# Logs and Report a problem

Errors and crashes are written to a log on your computer. Nothing is uploaded. If something goes wrong you can look at the log yourself or build a report to send to someone.

## The log

- Folder: `%APPDATA%\zotero-next-gpui\logs`. Set `ZN_LOG_DIR` to put it somewhere else.
- Open it from **Settings > System > Diagnostics > Error log > Open logs folder**.
- One file per day, `zotero-next-YYYY-MM-DD.log`, with one JSON object per line: time, level (`debug`, `info`, `warn`, `error`, `fatal`), area (`ui`, `core`, `reader`, `sync`, `websync`, `translate`, `bbt`, `worker`, `word`, `update`), message, stack, version, OS and a little context.
- Files older than 14 days are deleted. A file that would pass about 5 MB is renamed to `.old.log` and a new one starts, so a day takes at most about 10 MB.
- Passwords, API keys, tokens, cookies, long key-like strings and the fields that carry titles and notes are removed before anything is written. Your user folder is shown as `%USERPROFILE%`.
- A marker file `running-<pid>.json` is kept in the log folder while the app runs and removed on a clean exit. One left behind by a process that is gone means that session ended unexpectedly.

## Report a problem

Choose **Tools > Report a problem...**, or **Settings > System > Diagnostics > Report a problem**. A dialog shows one block of text:

- the app version and build, Windows version, Bun version;
- the number of library items and the sync mode;
- the log folder;
- the last two days of the log, redacted, capped at the newest 400 lines.

What you see is exactly what is copied or saved. Choose **Copy** to put it on the clipboard, or **Save as zip** to write `report.txt` into a zip in a folder you pick. Then send it yourself, for example in an issue on the repository. The report is built to contain no item titles, notes or file contents, but read it before you send it.

## Start-up timing

Launching from a terminal with `ZN_TRACE=1` prints start-up milestones such as `main-start` and `first-items`. This is mostly for developers; see [Building from source](../developer-guide/building.md).
