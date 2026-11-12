# Comparison with Zotero 10

Zinc reads and writes a Zotero library and speaks the same connector protocol, but it is a different program. Some things Zotero does are not here yet, and a few things here Zotero does not do.

The feature-by-feature grid is kept in one place, the repository README, in the section **Feature comparison with Zotero 10**:

[Feature comparison with Zotero 10 (repository README)](https://github.com/ABorakati/zinc#feature-comparison-with-zotero-10)

It is checked against an installed Zotero 10, so this page does not repeat the grid.

## Where the two differ in approach

- **Native interface.** Zinc draws its windows natively (GPUI) rather than in a browser engine. Web tabs (snapshots, EPUBs) and the rich note editor use the system web view: WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux. See [Architecture](../developer-guide/architecture.md).
- **Same data, same ports.** It can import a Zotero data folder ([First run](first-run.md)), keep in step with the local Zotero database or zotero.org ([Sync](sync.md)), and answer the Zotero connector on port 23119 while Zotero itself is not running ([Adding items](adding-items.md)).
- **Zotero's own translators.** The web, import and export translators are Zotero's ([translators runtime](../developer-guide/translators.md)).
- **Agents.** A built-in MCP server for the library and another for Word ([MCP](mcp.md)).
- **Platforms.** Windows 10 and 11 (x64), Linux (x64) and macOS (Apple Silicon). The Word add-in and Word MCP server, auto-update, the Zinc browser connector's helper, and the built-in institution sign-in window are Windows only.
