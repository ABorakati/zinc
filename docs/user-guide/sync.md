# Sync

Zinc can keep its library in step with your Zotero library in two different ways, and you choose one of them (or neither). Both are set up in **Settings > Sync** (see the [settings reference](settings.md#sync)).

| Sync source | What it is | Needs |
| --- | --- | --- |
| **Local Zotero** (default) | Reads the Zotero data folder on this computer (`zotero.sqlite` and `storage/`). Can optionally write your changes back. | Zotero installed on this computer. No account. |
| **zotero.org** | Talks to your zotero.org library directly over the Zotero Web API. | A zotero.org API key. |
| **Off** | No sync. | Nothing. |

Only one source runs at a time. This is deliberate: desktop Zotero already syncs to zotero.org, so running both routes at once would pass every change back and forth. Switching the source stops the old one and starts the new one.

The **Sync source** row in Settings > Sync has the three-way choice: Local Zotero, zotero.org, Off.

## Local Zotero

With the source set to Local Zotero, Zinc reads your Zotero library from its data folder. There is no Zotero plug-in and no account involved.

- **Reading is always on.** Changes made in Zotero appear in Zinc. While Zotero is running, Zinc reads from a snapshot copy of its database, so it never disturbs Zotero.
- **Writing is opt-in.** The **Write changes into Zotero** switch starts off. Turned on, edits made in Zinc are written directly into Zotero's database and storage folder, but only while Zotero is closed. While Zotero is open, your changes wait in a queue ("changes waiting to write") and are written the next time Zotero is closed and Zinc syncs.
- **Backups.** Before every write session Zinc makes a backup of `zotero.sqlite` in a `zotero-next-backups` folder inside the Zotero data folder, and keeps the last five. When you turn writing on you are asked to confirm that you have a backup ("I have a backup, turn on"); a backup of the whole Zotero data folder of your own is still sensible.
- **Checks.** After a write session the database is checked for integrity, and on any error the changes are rolled back and sync pauses with a visible error.

The **Zotero library** row in Settings shows the state of the data folder, when it was last read, how many changes are waiting and how many conflicts there are, and has a **Sync now** button. The **Zotero data folder** row shows which folder is in use; change it under [Files and folders](settings.md#files-and-folders) (**Find Zotero**, **Browse...**, **Validate**).

The same status and a **Sync now** button are in the sync indicator in the top bar, which also lists conflicts.

If another Zinc window (or a setting that turns sync off) owns the sync, the sync rows tell you so instead of showing a status.

## zotero.org

To sync straight with zotero.org:

1. Create an API key at `https://www.zotero.org/settings/keys` with library read/write access and file access.
2. In **Settings > Sync**, set **Sync source** to **zotero.org**.
3. In the **zotero.org account** row, paste the key and click **Connect**. The key is checked with zotero.org, and the row then shows "Connected as <username> (user <id>)". The paste field masks what you type.
4. The first sync starts. **Sync now** in the **zotero.org status** row runs one on demand.

**Where the key is kept.** The API key is stored in the operating system's secret store (through Bun's secrets support, service `zotero-next`), never in the library database, logs or the app's API responses. After you click Connect the field is cleared and the key is never shown again. **Remove key** forgets it; **Replace key** swaps it for a different one. If the key is read-only the row says so (sending changes needs write access); if it has no file access, attachment files cannot be synced.

### Reading and sending

- zotero.org's changes are always read in while this source is running.
- **Send changes to zotero.org** is the push switch and is **off by default**. Off: nothing is sent. On: edits made in Zinc are uploaded.

### Attachment files

The **Attachment files** row has three choices:

| Choice | Meaning |
| --- | --- |
| **Don't sync files** (default) | Attachment items and their metadata sync, but their files are neither downloaded nor uploaded. |
| **Download only** | Files of imported attachments that are missing on this computer are downloaded. |
| **Download and upload** | Files are downloaded, and files you add are uploaded. |

Downloaded files go to Zinc's own storage folder (`storage/<KEY>/` next to the library file). The attachment metadata always syncs whatever you choose here.

### Online-only files check

Some attachments exist on zotero.org but not on this computer. Before you free up space by removing files from your zotero.org storage (or cancel a storage plan), check what would be lost:

1. In the **Online-only files** row, click **Check online-only files**. This works even with files set to "Don't sync files". It needs a connected API key.
2. The result reads like "N imported attachments; M without a local file", and, for those M, how many are on zotero.org, how many are not on zotero.org, and how many are unknown, with a short sample (marked online, missing or ?).
3. If any are missing locally, click **Download missing files**. Progress is shown ("Downloaded X of Y files...").
4. Check again until none are left that are only on zotero.org. Only then clear the zotero.org storage.

Zinc never deletes files from zotero.org storage itself. The check only reports.

### Group libraries

Zinc finds the groups you belong to and syncs each one next to your personal library, in the same Sync now run. Each group shows up in the sidebar under **Group Libraries** (see [Group libraries](library.md#group-libraries)).

- **What your key allows.** The API key needs access to the groups, which you choose when you create it on zotero.org (all groups, or specific ones). The **Group libraries** row under zotero.org sync lists every group with its status. A group the key cannot read is listed as such and skipped.
- **Read-only groups never upload.** If you are only a member without editing rights (or the group's library editing is limited to admins), changes are pulled but nothing is pushed, and editing is turned off in the interface. Files follow the group's own file setting: a group that does not allow file editing for you does not receive uploads.
- **Leaving or losing a group.** If you leave a group, or it is deleted, the library is marked as removed. It stays on this computer until you remove it yourself; it is no longer synced.
- **Errors are per group.** One failing group (for example, no access) does not stop the others or your personal library; its error is shown on its own line.
- **Local Zotero route.** Sync through a local Zotero data folder still covers My Library only.

Keys are unique across the whole Zinc library. In the rare case that an item or collection in a group has the same key as one in another library here, Zinc skips that object and counts it in the sync result instead of overwriting anything.

### Status, rate limits and errors

The **zotero.org status** row shows the last sync time, the number of changes waiting to be sent, and the number of conflicts. zotero.org may ask clients to slow down; Zinc then pauses and shows "zotero.org asked us to wait; resuming at <time>". The last error, if any, is shown in red.

## Conflicts

A conflict happens when the same item or collection was changed both here and on the other side since the last sync. Zinc keeps one version and records the other:

- If only one side changed, that change wins.
- If both changed, the version with the newer modification date is kept, and the losing version is saved as a conflict.

Conflicts are counted in the status rows. The sync indicator in the top bar lists them side by side ("Zotero-next" and "Zotero"), marks which one was kept, and has a **Dismiss** button for each one you have reviewed.

## Not available yet

- **Sync automatically** is listed in Settings as not yet available.
- Group sync with a local Zotero data folder: only My Library is shared.
- Trash, saved searches and drag-and-drop between libraries are not handled for group libraries yet.

## Related

- [First run](first-run.md): importing your existing Zotero library when you first start.
- [Attachment storage](zotmoov-storage.md): files that arrive by sync are never moved by the storage rules.
- [Troubleshooting](troubleshooting.md)
- For the protocol details see `core/src/websync/CONTRACT.md` and `core/src/sync/protocol.ts`.
