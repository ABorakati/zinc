# Updates

Zinc can check a signed feed, download the update, verify it and install it: on Windows it runs the installer silently, on Linux it replaces its AppImage file, and on macOS it replaces Zinc.app. It only does so if the build you installed has a feed address and an update public key built in. A build without a key never updates, and you can always install a newer release by hand ([Install](install.md)).

## Settings

Under **Settings > System > Updates**:

| Setting | Meaning |
| --- | --- |
| Version | The installed build, for example `0.1.0+b7cd9fc4-20261106` (release number, commit, build date). |
| Check for updates | Checks now. This works even when automatic checks are off. |
| Check automatically | On by default. About 20 seconds after the first items load, then every 24 hours. Off means nothing is requested. |
| Download automatically | Off by default. |
| Update feed | The address of the `latest.json` feed. Linux and macOS read `latest-linux-x64.json` or `latest-darwin-arm64.json` next to it. With none configured, nothing is ever requested. |

A development build (run from source) is never offered an update.

## What you see

When a newer version exists a toast says **Zinc X is available** with three actions: **What's new** (the release notes), **Install on exit** and **Install now**.

- **Install now** waits for pending writes, closes the database, installs the update and exits. On Linux and macOS Zinc then starts again by itself.
- **Install on exit** installs it the next time you quit normally, without starting Zinc again. A crash installs nothing.

How the update is installed:

- **Windows**: the installer runs silently.
- **Linux**: the new AppImage is downloaded into the same folder as the one you run, as a hidden `.zinc-update-<version>.AppImage.download` file. When Zinc quits it takes the place of the old file, under the old file's name. So Zinc must be started from its AppImage, and you must be able to write to that folder.
- **macOS**: the new Zinc.app is downloaded and unpacked into a hidden `.zinc-update` folder next to Zinc.app. When Zinc quits, a small helper swaps the two apps and removes the folder. So Zinc must be in a folder you can write to, such as Applications, and not opened from the disk image.

If Zinc cannot replace itself (it is not running from an AppImage, or the folder is read-only), it still tells you about the new version, says why it cannot install it, and you install it by hand.

## Safety

- The feed is a manifest signed with an Ed25519 key. The app only accepts a manifest that verifies against the public key built into it.
- The download is resumable. On Windows it goes to `%LOCALAPPDATA%\zotero-next-gpui\updates`, on macOS to `~/Library/Application Support/zotero-next-gpui/updates`, on Linux next to the AppImage. Its size and SHA-256 must match the signed manifest, or the file is deleted. It is checked again right before it is installed.
- Each platform has its own signed manifest, and Zinc refuses a manifest meant for another platform.
- A manifest can mark an older install as too old to update in place; it is then told to install by hand.
- Your library is migrated when the new version first opens it. A backup `library.backup-v<from>-to-v<to>-<time>.sqlite` is made next to the library first (the last 3 are kept). A library that is newer than the app understands is refused, unchanged.
- Update events are logged under the `update` area ([Logs](logs-and-reports.md)).

How releases are made and the feed is hosted: [Releasing](../developer-guide/releasing.md).
