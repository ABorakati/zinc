# First run

The first time you start Zinc on a machine, no library is configured. Instead of an empty window you see a first-run screen with three choices. Nothing is opened or written until you choose.

| Choice | What it does |
| --- | --- |
| **Import from Zotero** | Looks for the Zotero data folder (the one your Zotero desktop program uses) and copies the library into a new Zinc library, with a progress bar. Your Zotero data is only read. If it is not found, or is somewhere unusual, you can pick the folder yourself. |
| **Open an existing library** | Pick a Zinc library file (`.sqlite`). The file is checked first; a file that is not a Zinc library is refused with a reason. |
| **Start an empty library** | Creates a new, empty library. You can add items, or import files later. |

A new library is created at `%APPDATA%\zotero-next\library.sqlite`. If that name is taken, `library-2.sqlite`, `library-3.sqlite` and so on are used; an existing library is never overwritten.

The screen also appears if a library you set earlier has gone (for example it was on a drive that is unplugged). It then says why.

## Where the library is found

On every start the app picks its library in this order:

1. The `ZN_DB` or `ZN_LIBRARY` environment variable.
2. The path saved in `%APPDATA%\zotero-next-gpui\library.json`.
3. A library left in the older location `<home>\zotero-next\data\library.sqlite`. It is adopted, which means its path is saved to the file above, so it keeps opening from there.
4. `%APPDATA%\zotero-next\library.sqlite`, if it exists.
5. None of these: the first-run screen.

To use another library later, go to **Settings > Files and folders > Library location > Change...**. The new library is used the next time the app starts. See the [Settings reference](settings.md#files-and-folders).

## After importing

- Zotero and Zinc can both be installed. How changes flow between them is described in [Sync](sync.md).
- Newer versions of the app migrate the library file's schema on opening. A backup copy is made first. See [Updates](updates.md) and, for details, [Database and migrations](../developer-guide/database.md).
