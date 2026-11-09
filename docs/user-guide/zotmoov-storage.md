# Attachment storage (ZotMoov-style)

By default Zinc keeps attachment files in its own storage folder, one subfolder per item, next to the library database. If you would rather keep your PDFs in a folder you choose (a OneDrive folder, a project folder, a shared drive), sorted and named in a readable way, use the attachment storage settings. They follow the approach of the Zotero add-on ZotMoov: files are placed in a folder of your choice, usually as **linked files**, and are named from their item.

All of this lives in **Settings > Files and folders** (see the [settings reference](settings.md#files-and-folders)).

## Quick setup

1. Open **Settings > Files and folders** and find **Attachment storage location**.
2. If you have OneDrive, the page suggests a `Zotero Library` folder inside it. Click **Use <that folder>** to apply the ZotMoov setup there. Otherwise click **Choose folder...** (or **Another folder with these settings...**) and pick a folder.
3. New attachments now go to that folder.
4. Optional: click **Move existing attachments to this folder...** to bring the files you already have along. You see a preview first.

The ZotMoov setup (also reachable later with **Apply ZotMoov defaults**) sets:

| Option | Value |
| --- | --- |
| Place new files automatically | On |
| Move or copy | Move |
| Files stored as | Linked files |
| Subfolder pattern | None (all files directly in the folder) |
| Name files from their item | On, and the attachment title follows the new file name |
| Tag files | On, tag `zotmoov` |
| File types | pdf, epub, docx, djvu |
| Delete files with their items | Off |
| Remove folders that become empty | On |

## The storage folder

**Attachment storage location** is a choice between **zotero-next's folder** (the built-in layout, `storage/<KEY>/` next to the library file) and **Choose folder...**. When you choose your own folder you can also set:

- **Subfolder pattern**: sorts files into subfolders inside the storage folder. Empty means no subfolders. Patterns use ZotMoov's wildcards in braces, for example `{%a}/{%y}` for a folder per first author and then per year. Common wildcards: `%a` author, `%y` year, `%t` title, `%j` publication, `%T` item type, `%c` collection path, `%b` citation key, `%I` author initials, `%p` publisher, `%v` volume, `%e` issue, and `%Y`/`%M`/`%R` for the year/month/day the item was added. `{%b | %a}` uses the first value that is not empty, and `{-%M}` adds text only when the value exists. The settings page lists the full set. A pattern must be relative to the storage folder; absolute paths and unknown wildcards are rejected, and the result can never leave the folder.
- A switch for whether new files are **linked files** in that folder (like ZotMoov) or imported files kept in that folder.

A linked attachment points at a file on disk instead of copying it into the library, so you can open the same folder from other programs. The related setting **Linked attachment base directory** stores linked paths relative to a folder, so they survive moving that folder; see the settings reference.

## Behaviour settings

These appear once a storage folder is chosen. Before that they show "Choose a storage folder first."

| Setting | What it does |
| --- | --- |
| Place new files in the storage folder automatically | Files you add, save from the browser, import or fetch with Find Full Text go straight to the storage folder. Off: only the Attachment Files commands in the item menu use it. Files that arrive by sync are never moved. Default: on. |
| Move or copy | **Move**: the file lives in the storage folder. **Copy**: it stays in the library's own storage and a copy is also placed in the storage folder. Default: Move. |
| File types to handle | Only these extensions go to the storage folder (others stay in the library's own storage), for example `pdf, epub, docx, djvu`. Empty means every file type. |
| Name files from their item | Names a placed file `Author - Year - Title.ext` from its parent item. A second switch makes the attachment's title follow the new file name. Default: off for naming, on for the title following the name. |
| Tag files in the storage folder | Attachments placed in the storage folder get a tag (default `zotmoov`), so they are easy to find. Converting one back to a stored file removes the tag. Default: off. |
| Folder and file names | **Strip diacritics from names and folders** (e acute becomes e), and the text the `%U` wildcard stands for in subfolder patterns (default `undefined`). |
| Delete files with their items | When a linked attachment in the storage folder is deleted permanently (Delete Permanently, Empty Trash), its file is deleted too, unless another attachment uses it. Items deleted by sync never delete files. A second switch removes folders that become empty (default: on). Default for deleting files: off. |
| Attach newest file from | A folder (for example Downloads) used by the **Attach Newest File** command. Buttons: **Choose folder...**, **Show in folder**, **Clear**. A switch asks for the file name before attaching. |

## Item menu commands

Right-click an item and use the **Attachment Files** submenu:

| Command | Does |
| --- | --- |
| Move to Storage Folder / Copy to Storage Folder | Applies your move-or-copy setting to the item's files, into the storage folder and subfolder pattern. Shown only when a storage folder is chosen. |
| Move to Folder... / Copy to Folder... | The same into a folder you pick now. |
| Convert to Stored File | Turns linked files back into stored files in the library's own storage. |
| Attach Newest File from <folder> | Attaches the most recently saved file of the "attach from" folder to the selected item and removes it from that folder once the copy is verified. Shown for one regular item at a time, and only when an "attach from" folder is set (the label reads "Attach Newest File..." until then). |

## Safety

- Moving a file is done in steps: the file is copied, checked against the original, recorded in the database, and only then removed from its old place. If something fails the file stays where it was and the result is reported.
- OneDrive files that are online-only are skipped, not downloaded.
- Files that cannot be moved (for example a file open in another program) are skipped and reported with a reason.
- The settings are stored in `zotero-next.config.json`, in the same folder as `library.sqlite`.

## Related

- [Settings reference: Files and folders](settings.md#files-and-folders)
- [Sync](sync.md): files that arrive by sync are never moved automatically.
- [Find Full Text](find-full-text.md): fetched PDFs follow the same rules.
