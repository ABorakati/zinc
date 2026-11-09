# Product

<!-- impeccable:product-schema 1 -->

## Platform

web (the project website in `website/`; the product itself is a native Windows desktop app)

## Users

For now the website has one reader: the author, a researcher and clinician who uses Zotero daily and built Zinc as their own replacement. It is a private showcase and documentation hub, run locally; it is not published. The product's own users are researchers who already keep a Zotero library and cite in Word.

## Product Purpose

Zinc is a fast, native Windows reference manager that works with an existing Zotero library: it imports or syncs the library, reads and annotates PDFs, saves from the browser, and cites into Word. It exists because Zotero is slow to start and search on a large library. Success is daily use in place of Zotero without losing data or Zotero compatibility.

## Positioning

The same Zotero library, on a different engine: a single native process (Zed's GPUI, Bun AOT, a Rust/PDFium PDF library) instead of a browser engine. Measured against Zotero 10.0.7 on a 12.4k-item library: window 0.49 s vs 1.83 s, library ready 0.70 s vs 16.3 s, search 35–50 ms vs ~2 s, working set 358 MB vs 783 MB. Saving, citing and agent access keep working with the app closed. Lead claim for the site: speed (delegated to Claude; the user had no preference).

## Operating Context

Windows 10/11 x64 desktop. Works alongside desktop Zotero (local sync) or zotero.org (Web API sync), Microsoft Word (add-in with sidebar), Chrome/Edge (connector), and AI agents over MCP (Claude Code).

## Capabilities and Constraints

- Library: Cards and Classic table views, coloured/pinned collections, saved searches, tags, duplicates, My Publications, Better BibTeX keys and auto-export, ZotMoov-style storage, Zotero translators, Find Full Text with institution sign-in, Locate engines.
- Reader: PDFium-rendered PDFs, annotations, reflowed reading view with figure/table/reference cards; notes; snapshot and EPUB tabs.
- Not supported: macOS/Linux, group libraries, Zotero plugins, LibreOffice/Google Docs, Read Aloud.
- The repository and releases are private; the site must not imply public availability or link to anything public.

## Brand Commitments

- Name "Zinc"; app icon in `gpui-ui/assets/icon.svg` (red "Z" mark). Must state it is not affiliated with the Zotero project.
- Voice: plain, factual, honest about limits (the README states where Zinc is worse, e.g. private memory, program size).

## Evidence on Hand

- Benchmarks and the feature grid in `README.md` (measured with `gpui-ui/scripts/bench-vs-zotero.ts`); the site reads them from the README at build time.
- Screenshots in `docs/screenshots/` (demo library of public papers; light and dark).
- No testimonials, users, press, pricing or licence claims exist; do not invent any.

## Product Principles

1. Numbers over adjectives: every speed or memory claim comes from the README's measured tables.
2. Honest about trade-offs: show where Zotero is better as plainly as where Zinc is.
3. Zotero-compatible first: never imply the user must leave Zotero or lose data.
4. One source of truth: site content that duplicates the README is generated from it.
