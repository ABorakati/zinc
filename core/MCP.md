# zotero-next MCP server

Lets agents (Claude Code etc.) search and work with the library. Two transports, same tools.

| Transport | When | Endpoint |
|-----------|------|----------|
| Streamable HTTP | desktop app / core server running | `http://127.0.0.1:23120/mcp` |
| stdio | works with the app closed (opens the SQLite file directly; WAL + busy_timeout let it coexist with the app) | `bun core/scripts/mcp-stdio.ts --db <path>` |

The HTTP endpoint is stateless (JSON responses, POST only), accepts only loopback Host headers, and rejects any browser request whose Origin is not exactly the server's own origin (DNS-rebinding guard).

## Tools

Read-only: `search_library`, `list_items`, `get_item`, `get_fulltext`, `get_annotations`, `list_collections`, `get_file_path`.
Write: `create_collection`, `add_to_collection`, `remove_from_collection`, `add_tags`, `remove_tags`, `update_item`, `restore_item`.
Destructive (annotated `destructiveHint`): `trash_item` (recoverable), `update_item` (overwrites fields).

| Tool | Purpose |
|------|---------|
| `search_library {query, limit?, offset?}` | FTS over metadata, notes and PDF full text; snippets with **bold** matches, `matchedIn` |
| `list_items {collection?, tag?, unfiled?, trash?, q?, sort?, dir?, limit?, offset?}` | Browse top-level items with totals |
| `get_item {key}` | Metadata, tags, collection names, attachments (path, hasFile) and notes as plain text |
| `get_fulltext {key, maxChars?, offset?}` | Extracted text of an attachment, or a parent's best attachment; paged |
| `get_annotations {key}` | Highlights/notes: text, comment, page label, colour |
| `list_collections {}` | Collection tree with keys and counts |
| `create_collection {name, parentKey?}` | New collection |
| `add_to_collection` / `remove_from_collection {collectionKey, itemKeys[]}` | Membership |
| `add_tags` / `remove_tags {itemKey, tags[]}` | Tags (search re-indexed) |
| `update_item {key, fields}` | PATCH Zotero fields; key, itemType, tags, collections, trash state are refused |
| `trash_item` / `restore_item {key}` | Trash and restore |
| `get_file_path {key}` | Absolute path of the attachment file (best PDF for a parent key) |

## Claude Code setup

stdio (works with the app closed):

```
claude mcp add zotero-next --scope user -- C:\Users\abora\.bun\bin\bun.exe C:\Users\abora\zotero-next\core\scripts\mcp-stdio.ts --db C:\Users\abora\zotero-next\data\library.sqlite
```

HTTP (app/core server must be running):

```
claude mcp add --transport http zotero-next-http --scope user http://127.0.0.1:23120/mcp
```

Use one of the two (or register them under different names), not both under the same name.

## Run / test

```
bun core/src/server.ts --db data/library.sqlite     # serves /api and /mcp
cd core && bun test test/mcp                        # MCP tests
```
