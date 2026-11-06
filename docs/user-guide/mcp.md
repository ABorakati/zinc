# MCP for AI agents

Zotero Next has two separate [Model Context Protocol](https://modelcontextprotocol.io) servers, so an AI agent such as Claude Code can work with your references:

| Server | What an agent can do | Where it runs |
| --- | --- | --- |
| **Library MCP** (core) | Search and read items, full text and annotations; organise collections and tags; format bibliographies | `http://127.0.0.1:23120/mcp` while the app is running, or over stdio with the app closed |
| **Word MCP** (add-in) | Read and edit citations and the bibliography in a document open in Word | `http://127.0.0.1:23125/mcp` while Word is running with the add-in |

Both listen on the loopback address only. Neither is reachable from other computers, and both refuse requests that come from a web page.

Use agents with care. They can edit and trash items (the library server) or rewrite citations in your document (the Word server). Trash is recoverable and Word has undo, but keep a backup of your library.

## Library MCP

### Connecting

**HTTP** (the app, or the core server, must be running):

```
claude mcp add --transport http zotero-next-http --scope user http://127.0.0.1:23120/mcp
```

**stdio** (works with the app closed; it opens the library file directly, and the database's write-ahead logging lets it coexist with the running app):

```
claude mcp add zotero-next --scope user -- bun <repo>/core/scripts/mcp-stdio.ts --db <path-to>/library.sqlite
```

Replace `<repo>` with your checkout of the Zotero Next source and `<path-to>/library.sqlite` with your library file (by default `%APPDATA%\zotero-next\library.sqlite`; **Settings > Files and folders > Library location** shows the real path). Use the full path to `bun` if it is not on your `PATH`. Register only one of the two under a given name.

The HTTP endpoint is stateless (JSON responses, POST only; a GET answers 405). It accepts only loopback `Host` headers and rejects any request with a browser `Origin` that is not its own, as a guard against DNS rebinding. Non-browser clients send no `Origin` and are fine. There is no token on this server, so anything on your computer that can reach port 23120 can use it.

### Tools

Read-only:

| Tool | Purpose |
| --- | --- |
| `search_library` | Full-text search over metadata, notes and PDF text; results carry snippets with the matches marked and where they matched |
| `list_items` | Browse top-level items, optionally by collection, tag, unfiled or trash, with sorting and paging |
| `get_item` | One item's metadata, tags, collections, attachments (with paths) and notes as plain text |
| `get_fulltext` | Extracted text of an attachment, or of a parent item's best attachment; paged |
| `get_annotations` | Highlights and notes on an item's PDF: text, comment, page label, colour |
| `list_collections` | The collection tree with keys and counts |
| `get_file_path` | Absolute path of an attachment file (the best PDF for a parent item) |
| `format_bibliography` | Format items as a bibliography or one in-text citation in any CSL style (default: your Quick Copy style); text, HTML or RTF |

Write:

| Tool | Purpose |
| --- | --- |
| `create_collection` | Create a collection, optionally under a parent |
| `add_to_collection`, `remove_from_collection` | Change collection membership (items are never deleted by this) |
| `add_tags`, `remove_tags` | Add or remove tags on an item |
| `update_item` | Patch Zotero fields on an item. The key, item type, tags, collections and trash state cannot be changed this way. Marked as destructive because it overwrites fields. |
| `trash_item`, `restore_item` | Move an item to the trash, or bring it back. Marked as destructive, though trashing is recoverable. |

Item keys are 8-character strings. Results are paged with `limit` and `offset`. Full parameters are documented in `core/MCP.md` and the tool schemas themselves, which the agent reads from the server.

## Word MCP

The Word add-in (see [Word add-in](word.md)) runs its own MCP server so an agent can work on the document you have open in Word: find sources, insert and edit citations, build the bibliography and change the style. It exists only while Word is running with the add-in loaded, and is on by default.

### Security

- It listens on `127.0.0.1` port **23125** (change it with the add-in's `mcpPort` setting).
- Every request needs `Authorization: Bearer <token>`. The token is a random string created the first time the add-in starts and kept in `%APPDATA%\zotero-next-word\mcp-token`. The file is readable only by your Windows user, and the token is never logged. Treat it like a password.
- A request with an `Origin` header is refused (browsers send one), and the `Host` header must be the loopback address.
- Tool calls run one at a time on Word's own thread.

### Settings

The add-in's settings file is `%APPDATA%\ZoteroNextWord\settings.json`. Relevant keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `mcpEnabled` | on | Set to `false` to switch the Word MCP server off |
| `mcpPort` | `23125` | The port to listen on |
| `mcpTimeoutMs` | `120000` | How long one tool call may take (5 seconds to 10 minutes) |

Restart Word after changing them. If the port is taken (for example by a second Word instance), the server does not start, and the add-in itself keeps working.

### Connecting

Do not paste the token into chat or scripts you share. Read it from the file when you register the server. In Git Bash or another POSIX shell:

```
claude mcp add --transport http zotero-next-word --scope user http://127.0.0.1:23125/mcp \
  --header "Authorization: Bearer $(cat "$APPDATA/zotero-next-word/mcp-token")"
```

In PowerShell:

```
claude mcp add --transport http zotero-next-word --scope user http://127.0.0.1:23125/mcp `
  --header "Authorization: Bearer $((Get-Content "$env:APPDATA\zotero-next-word\mcp-token").Trim())"
```

This stores the token in the Claude Code configuration, so if the token file is ever deleted or regenerated you must register the server again. Other clients take the same two things: the URL `http://127.0.0.1:23125/mcp` and an `Authorization: Bearer <token>` header (written here with the placeholder `<token>`).

### Tools

Tools that touch a document take an optional `document` argument (a name or path from `list_documents`); without it they use the active document.

| Tool | Purpose |
| --- | --- |
| `list_documents` | List the documents open in Word: name, path, whether active, saved, read-only |
| `search_library` | Search your Zotero Next library (title, creators, abstract, publication, tags; a DOI or a year also works). Returns item keys for the citation tools. Does not touch a document |
| `search_styles` | Find citation styles by name; returns the style `id` for `set_style` and whether it is installed |
| `list_citations` | List every citation in the document in order (body, footnotes, endnotes) with a stable `fieldId`, the rendered text and the cited items, plus the document's style and whether it has a bibliography |
| `insert_citation` | Insert a citation citing one or more library items at the cursor, at the end, or after a given piece of text; then reformat numbering |
| `edit_citation` | Replace the items of an existing citation (add or remove items, set locators, prefixes, suffixes), found by index or `fieldId` |
| `delete_citation` | Delete a citation and refresh the bibliography; one undo step in Word restores it |
| `insert_bibliography` | Insert a bibliography if there is none, or update the existing one |
| `get_document_prefs` | Read the document's style, locale, in-text vs footnotes vs endnotes, automatic updating and whether it has a bibliography |
| `set_style` | Change the document's citation style (and optionally locale) and reformat; moves citations between text and notes when needed. Affects this document only |
| `set_document_prefs` | Change the note type (footnotes or endnotes) and whether citations update automatically |
| `refresh` | Re-read the fields, re-fetch the cited items from the library, and reformat everything. Hand-edited citations are left alone unless told otherwise |

A typical agent flow is `search_library` to find the item keys, `insert_citation` with those keys, `insert_bibliography`, then `refresh` after the library changes.

## Troubleshooting

- **Library MCP: connection refused.** The app (or `bun core/src/server.ts --db <library>`) is not running, or something else is using port 23120. Use the stdio form instead.
- **Word MCP: 401.** The bearer token is missing or wrong. Re-read the token file and re-register.
- **Word MCP: 403.** The request carries an `Origin` header or a non-loopback `Host`; use a non-browser client.
- **Word MCP: nothing listening on 23125.** Word is closed, the add-in is not loaded, `mcpEnabled` is off, or the port is in use. The add-in writes a small log at `%LOCALAPPDATA%\ZoteroNextWord\addin.log`; look for lines starting `mcp:`.
- General problems: [Troubleshooting](troubleshooting.md).
