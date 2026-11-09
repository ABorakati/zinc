# Import and export

Zinc reads and writes the common reference formats itself, and can use Zotero's own translators for many more. This page lists what is supported and where to find it in the app.

Importing your existing Zotero library when you first start the app is a separate, one-off step; see [First run](first-run.md). To keep a library in step with Zotero continuously, see [Sync](sync.md).

## Import

Open the **Tools** menu (the wrench button in the toolbar) and choose:

| Command | What it does |
| --- | --- |
| **Import...** | Pick one or more files. Each file is imported into a new collection named after the file. |
| **Import from Clipboard** | Imports whatever reference data is on the clipboard into a new collection named "Clipboard import <date>". |
| **Import from Mendeley Desktop...** | Lists the Mendeley Desktop libraries found on this computer and imports the one you choose. |

The format is detected automatically from the text, so you do not choose one. If a collection was selected in the format itself (Zotero RDF carries its own collection tree), the collections from the file are created instead of one new collection.

### Formats read natively

| Format | Typical file | Notes |
| --- | --- | --- |
| BibTeX / BibLaTeX | `.bib` | |
| RIS | `.ris` | EndNote, Mendeley, Zotero and most databases export it |
| CSL JSON | `.json` | |
| EndNote XML | `.xml` | |
| PubMed (nbib / MEDLINE) | `.nbib` | |
| Zotero RDF | `.rdf` | Items, notes, collections and attachment files |
| MODS | `.xml` | Library catalogue format |

For Zotero RDF, relative attachment paths are resolved against the folder the file came from, so keep the `files` folder next to the `.rdf` file.

### More formats through Zotero translators

If none of the native readers recognises the text (or they find nothing in it), Zinc hands it to Zotero's import translators. These are the same translators Zotero uses, vendored with the app and updatable (see [Translators](../developer-guide/translators.md)). They cover many formats not listed above, for example MARC, Refer/BibIX and CSV, provided the matching translator is present in your translators folder. Which formats are available therefore depends on the translators installed; a file the translators cannot recognise gives an "unrecognised format" error.

### What happens on import

- Items whose **DOI** is already in the library are skipped, and the result tells you how many ("N already in the library").
- Attachments mentioned in the file (for example in Zotero RDF) are added as linked or stored files when the file exists on disk.
- If **Automatically tag items with keywords and subject headings** is on in Settings > General, tags are added from keywords and subject headings in the file. If **Automatically attach associated PDFs when adding items** is on, a Find Full Text run starts for the new items. Both are on by default. See [Settings](settings.md#general) and [Find Full Text](find-full-text.md).
- After an import into a new collection, the view switches to that collection.

### Mendeley

The Mendeley import reads a **Mendeley Desktop** library file from `%LOCALAPPDATA%\Mendeley Ltd\Mendeley Desktop`. The file is copied before it is read and the original is never modified. It brings in references, collections and attachments, and reports files it could not find on disk. Encrypted databases cannot be read. The online Mendeley Reference Manager is a different product and is not supported.

## Export

There are two places to start an export:

- Right-click one or more items and choose **Export Item...** (or **Export N Items...** for several). It is hidden for attachments and notes.
- Right-click a collection in the sidebar and choose **Export Collection...** (the collection and its subcollections).

The Export dialog lists the formats, an **Include notes** checkbox, and then asks you for a folder to save into. There is no separate command to export the whole library from the app; select all items (or use the library view and select all) and export them, or use an automatic export from [Better BibTeX](better-bibtex.md).

### Built-in export formats

| Format | File | Notes |
| --- | --- | --- |
| BibTeX | `.bib` | For LaTeX |
| BibLaTeX | `.bib` | For biblatex |
| RIS | `.ris` | EndNote, Mendeley, Zotero |
| CSL JSON | `.json` | For citation processors |
| CSV | `.csv` | Spreadsheet columns as Zotero writes them; notes go into a Notes column as plain text |
| Zotero RDF | `.rdf` | Items, notes and attachment files; the folder also gets the files in `files/1`, `files/2` and so on, the way Zotero writes them |
| MODS | `.xml` | |
| Better BibTeX | `.bib` | With stable citation keys; see [Better BibTeX](better-bibtex.md) |
| Better BibLaTeX | `.bib` | |
| Better CSL JSON | `.json` | Citation keys as ids |
| Better CSL YAML | `.yml` | Citation keys as ids |

Below these, if the translators are available, a **More formats (Zotero translators)** list shows the other export formats Zotero's translators provide. The formats that are already built in are hidden from that list. Their output is saved to a folder the same way.

The last format and the notes choice are remembered. You can set the defaults in **Settings > Export**: **Default export format** and **Include notes**. See the [settings reference](settings.md#export).

## Formatted citations and bibliographies

Those are not an export format. To copy or save formatted references in a citation style, see [Citations and bibliographies](citations.md).

## Other ways to bring references in

- **Add by identifier** (DOI, ISBN, PMID, arXiv id) and **Add from URL**: see [Adding items](adding-items.md).
- The browser connector saves from web pages: see [Adding items](adding-items.md).
