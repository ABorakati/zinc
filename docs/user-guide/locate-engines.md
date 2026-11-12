# Locate engines

**Locate** is the submenu that takes an item to somewhere else: its web page, your library's catalogue, a search engine, or its file in your file manager. It is the app's version of Zotero's Locate menu.

## Where the Locate menu is

- Right-click an item in the list and choose **Locate**.
- On the item pane, open the **⋯** menu in the header and choose **Locate**.

## The menu entries

The first four entries are always there. An entry that does not apply to the selected item is greyed out rather than hidden.

| Entry | Opens | Greyed out when |
|---|---|---|
| **View Online** | The item's URL (web addresses only), or else `https://doi.org/` followed by its DOI. | The item has neither a URL nor a DOI. |
| **Library Lookup** | Your library's OpenURL resolver with the item's details (see below). | No resolver is set, or the item has too little to look up (no title, standard number or identifier). |
| **Search Google Scholar** | A Google Scholar search for the item's title. | The item has no title. |
| **Show File** | The item's attachment in your file manager. | The item has no attachment file to show. |

After a divider come your own **engines**, one entry per enabled engine, in the order you set. An engine entry is greyed out if the item cannot fill in the engine's search address (for example, no title). Links open in your browser.

Zotero's own default engine is Google Scholar. While an engine named "Google Scholar" is enabled in your list, it replaces the built-in **Search Google Scholar** entry instead of repeating it.

## Managing engines

Open **Settings > General** and find the **Locate** group:

| Setting | What it does |
|---|---|
| **Locate engines** | The list of engines. Use the switch to enable or disable one, the up and down arrows to reorder, and the bin to remove it. The row shows the engine's host name. |
| **Add a Locate engine** | Paste the address of an **OpenSearch description** (an XML file a search site publishes, such as `https://example.org/opensearch.xml`) and click **Add engine from URL…**. The engine appears in the menu straight away. |
| **Import or reset engines** | **Import from Zotero** copies the engines from the `locate/engines.json` file in your Zotero data folder; an engine with the same name is replaced and new ones are added. **Restore defaults** returns to the starting list. |
| **OpenURL resolver** | The address of your library's resolver, used by **Library Lookup**. |

Notes:

- The app only reads Zotero's `locate/engines.json`. It never changes it, and your engines are kept separately in the app's own settings (`ui-state.json` in the settings folder, see [Folders](first-run.md#folders)).
- Engines that use the POST method are listed but marked "POST: not supported" and do not work from the menu.
- With no engines at all, the list says "No engines. Add one below or restore the defaults."

### How an engine builds its link

An engine's address is a template. The parts in braces are filled in from the item:

| Placeholder | Filled with |
|---|---|
| `{searchTerms}` | The item's title. |
| `{z:title}`, `{z:year}`, `{z:openURL}` | A Zotero item field, the year, or an OpenURL context. |
| `{rft:aulast}`, `{rft:aufirst}` and other `rft:` names | A field of the item in OpenURL form (author last or first name, journal title, volume and so on). |
| `{name?}` | The same, but optional: if the item has no value, nothing is inserted. Without the `?`, a missing value means the engine is greyed out for that item. |

Values are URL-encoded, so a title containing `&` or `#` is safe.

## The OpenURL resolver

If your university or hospital library has an OpenURL link resolver, enter its base address under **Settings > General > Locate > OpenURL resolver** (for example `https://library.example.edu/openurl/`). The address must start with `http` or `https`. **Library Lookup** then opens the resolver with the item's details as an OpenURL 1.0 query (journal format for articles, book format for books and chapters), so the library can show you whether you have access. Leave the box empty to switch **Library Lookup** off.

## Relation to Find Full Text

Locate sends you to a page; it does not download anything. To have the app fetch and attach a PDF for you, use [Find Full Text](find-full-text.md).
