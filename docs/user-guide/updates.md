# Updates

Zinc can check a signed feed, download the installer, verify it and run it silently. It only does so if the build you installed has a feed address and an update public key built in. A build without a key never updates, and you can always install a newer `Zinc-Setup-<version>.exe` over the top by hand ([Install](install.md)).

## Settings

Under **Settings > System > Updates**:

| Setting | Meaning |
| --- | --- |
| Version | The installed build, for example `0.1.0+b7cd9fc4-20261106` (release number, commit, build date). |
| Check for updates | Checks now. This works even when automatic checks are off. |
| Check automatically | On by default. About 20 seconds after the first items load, then every 24 hours. Off means nothing is requested. |
| Download automatically | Off by default. |
| Update feed | The address of the `latest.json` feed. With none configured, nothing is ever requested. |

A development build (run from source) is never offered an update.

## What you see

When a newer version exists a toast says **Zinc X is available** with three actions: **What's new** (the release notes), **Install on exit** and **Install now**.

- **Install now** waits for pending writes, closes the database, starts the installer silently and exits.
- **Install on exit** does the same the next time you quit normally. A crash installs nothing.

## Safety

- The feed is a manifest signed with an Ed25519 key. The app only accepts a manifest that verifies against the public key built into it.
- The installer is downloaded to `%LOCALAPPDATA%\zotero-next-gpui\updates` (resumable). Its size and SHA-256 must match the signed manifest, or the file is deleted. It is checked again right before it runs.
- A manifest can mark an older install as too old to update in place; it is then told to install by hand.
- Your library is migrated when the new version first opens it. A backup `library.backup-v<from>-to-v<to>-<time>.sqlite` is made next to the library first (the last 3 are kept). A library that is newer than the app understands is refused, unchanged.
- Update events are logged under the `update` area ([Logs](logs-and-reports.md)).

How releases are made and the feed is hosted: [Releasing](../developer-guide/releasing.md).
