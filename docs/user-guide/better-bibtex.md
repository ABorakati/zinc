# Better BibTeX

Zinc has Better BibTeX (BBT) built in. It gives every item a stable citation key, adds Better BibTeX and Better BibLaTeX export formats, keeps `.bib` files up to date automatically, and answers the local HTTP endpoints that Pandoc filters and editor plug-ins already know how to talk to. There is nothing to install.

**Credit and scope.** This is a re-implementation of the behaviour of [Better BibTeX for Zotero](https://github.com/retorquere/zotero-better-bibtex) by Emiliano Heyns (MIT licence), written from its documented behaviour. No BBT source was copied; the attribution is in `core/src/bbt/NOTICE`. Some things are not ported: eta templates, Juris-M fields, jieba/kuromoji/pinyin transliteration, TeXstudio push, the BBT JSON (jzon) debug format and group libraries. The Unicode-to-LaTeX tables are a small hand-written subset, so unusual characters may be exported differently from the original plug-in.

## Citation keys

Every regular item (not notes, attachments or annotations) has a citation key, generated from a formula. You can see it:

- in the **Citation Key** row at the top of an item's Info section, with **Pin**, **Unpin** and **Refresh** buttons;
- as a **Citation Key** column in the table view.

To copy it, right-click an item and choose **Copy Citation Key**. What is copied depends on the **Copy citation key format** setting (LaTeX `\cite{key}`, Pandoc `[@key]`, bare `@key`, and so on).

### The formula

The default formula is:

```
auth.lower + shorttitle(3,3) + year
```

For *Attention Is All You Need* (Vaswani et al., 2017) this gives something like `vaswani_attention_2017`-style keys, depending on the title and skip words. A formula is built from:

- **Functions** that start with a lower-case letter and produce text: for example `auth`, `authors`, `shorttitle`, `veryshorttitle`, `title`, `year`, `shortyear`, `month`, `journal`, `firstpage`, `lastpage`, `keyword`, `zotero`.
- **Field access** with an upper-case name, such as `Title` or `DOI`.
- **Filters** chained with a dot: for example `.lower`, `.clean`, `.condense("-")`, `.abbr`, `.default("text")`.
- `+` to join parts, quoted text for literals, and `|` or `;` to separate alternatives (the first alternative that yields text wins).

The formula follows BBT's documented syntax, so most formulas you already use should work. In **Settings > Better BibTeX** the formula box checks what you type as you type: it shows a preview of the key for the item you have selected (or a sample item), or an error with the character position. **Save formula** is only enabled for a formula that is valid and changed. An invalid formula is never saved.

### Duplicates, pinning and refreshing

- If two items would get the same key, the later one gets a postfix. The **Duplicate postfix** setting controls it: `%(a)s` gives a, b, c..., `%(A)s` gives A, B, C..., `%(n)s` gives 1, 2, 3....
- **Pin** fixes an item's key so the formula no longer changes it. Editing the key in the item pane and pressing Enter pins the value you typed. **Unpin** regenerates it from the formula straight away. A pinned key is stored on the item (Zotero's own Citation Key field, or a `Citation Key:` line in Extra), so it syncs with the item.
- Generated keys are kept in a local table and are not synced. Each key is only regenerated when something that affects it changes. After you change the formula, the settings page tells you how many keys are out of date; **Refresh all citation keys** regenerates every key that is not pinned.

## Exports

Four Better formats are available wherever you export (see [Import and export](import-export.md)):

| Format | Extension | Notes |
| --- | --- | --- |
| Better BibTeX | `.bib` | ASCII LaTeX output by default |
| Better BibLaTeX | `.bib` | Keeps Unicode by default |
| Better CSL JSON | `.json` | Citation keys as ids |
| Better CSL YAML | `.yml` | Citation keys as ids |

Export items from the item right-click menu (**Export Item...**), a collection from its menu (**Export Collection...**), or the whole library, and pick one of the Better formats in the dialog.

## Automatic exports

An automatic export keeps a file on disk in step with the library. It is rewritten whenever relevant items change, and only when the text actually differs. The file is written atomically (to a temporary file in the same folder, then renamed), so a tool reading it never sees a half-written file.

To add one, go to **Settings > Better BibTeX > Automatic exports**:

1. Choose the format (Better BibTeX, Better BibLaTeX, Better CSL JSON or Better CSL YAML).
2. Choose the scope: **Whole library**, or one collection (its sub-collections are included).
3. Choose the trigger: **On change** or **When idle**.
4. Type the full path of the file to write, or click **Choose folder...** to pick a folder and get a suggested file name.
5. Click **Add**. The export runs once immediately.

Each entry in the list shows its path, format, scope, trigger, status ("Up to date", "Waiting to export", "Exporting..." or an error), when it last ran and how many items it wrote. **Export now** runs it at once; **Remove** deletes the entry (the file on disk is left alone).

On change waits for the **Auto-export delay (seconds)** after the last edit; When idle waits for **Auto-export idle time (seconds)** of quiet. Auto-exports are run by the app, so they only update while Zinc is running.

## HTTP endpoints

For tools built for BBT (Pandoc filters, citation pickers in Obsidian, VS Code, Emacs and vim, zotxt-style tools), the app serves BBT's endpoints on the Zotero-compatible port **23119** on `127.0.0.1`. Zinc only listens on that port while the real Zotero is not running; if Zotero is open it answers instead. Browsers are refused (a request with a web `Origin`, or a non-local `Host`, gets HTTP 403); command-line tools and editors, which send no `Origin`, work.

| Path | What it does |
| --- | --- |
| `/better-bibtex/cayw` | Cite as you write. `?probe` answers `ready`. `?items=key1,key2` (or `citekeys=`) formats those citation keys or item keys; `?selected=1` uses the items currently selected in the app. `format=` picks the output (see below). `clipboard=1` also copies the result. |
| `/better-bibtex/json-rpc` | JSON-RPC 2.0, by POST (or GET with the request in the query). |
| `/better-bibtex/export/library?/0/library.bibtex` | Whole library; the extension picks the format. Also available as `/better-bibtex/library`. |
| `/better-bibtex/export/collection?/0/<collection path>.bibtex` | One collection, by path or key. Also `/better-bibtex/collection`. |
| `/better-bibtex/export/selected?bibtex` | The items selected in the app. Also `/better-bibtex/select`. |
| `/better-bibtex/export/item?citationKeys=a,b&translator=biblatex` | Specific items by citation key; add `&pandocFilterData=true` for the JSON that the Pandoc filter expects. |
| `/better-bibtex/export?/library;id:1/My%20Library.bibtex` | The URL form BBT shows for "Download Better BibTeX export". |

The export extensions understood are `bibtex`, `biblatex`, `bib`, `json`, `csljson`, `yaml`, `yml` and `cslyaml`. Add `exportNotes=true` to include child notes.

`format=` values for CAYW: `cite` (the default; also `latex`, `natbib`, `citep`, `citet`), `biblatex`, `key`, `pandoc`, `mmd`, `textcite`, `asciidoctor-bibtex`, `typst`, `org-mode`, `jupyter`, and the data formats (`json` and formatted output). Use `command=` to change the LaTeX command and `brackets=1` for Pandoc brackets.

JSON-RPC methods: `api.ready`, `user.groups`, `item.search`, `item.citationkey`, `item.attachments`, `item.collections`, `item.notes`, `item.bibliography`, `item.regenerate_key`, `item.export`, `item.pandoc_filter` and `autoexport.add`. The `item.*` methods are also reachable as `items.*`. Zinc has a single library, so the library arguments accept "My Library", `0`, `1` or `*`; groups do not exist.

Example, with the app running and Zotero closed:

```
curl "http://127.0.0.1:23119/better-bibtex/export/library?/0/library.bibtex"
curl "http://127.0.0.1:23119/better-bibtex/cayw?selected=1&format=pandoc&brackets=1"
```

**Limitation.** The interactive cite-as-you-write picker (a pop-up search window) is not available in this app yet. Without `items=` or `selected=1`, `/better-bibtex/cayw` returns HTTP 503 with a message saying so. Select the items in the app and use `selected=1`, or pass the keys.

The same data is also served by the core's own API under `/api/bbt/...`, on port 23120; see [HTTP API](../developer-guide/http-api.md).

## Settings

The **Better BibTeX** page in [Settings](settings.md#better-bibtex) holds:

- Citation key formula, Refresh all citation keys, Transliterate keys to ASCII, Keys differing only in case are duplicates, Skip words, Duplicate postfix, Characters removed from keys;
- export options: Better BibTeX: ASCII output, Better BibLaTeX: ASCII output, Protect capitalisation in titles, DOI and URL, Export child notes, Export Extra as note;
- Copy citation key format and LaTeX cite command;
- the auto-export timings and the Automatic exports list.

Better BibTeX settings are stored in the library database on this machine only; they are not synced.
